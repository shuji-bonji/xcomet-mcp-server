import { spawn } from "child_process";
import type { EvaluateOutput, DetectErrorsOutput, BatchEvaluateOutput } from "../schemas/index.js";

/**
 * Configuration for xCOMET service
 */
export interface XCometConfig {
  model: "Unbabel/XCOMET-XL" | "Unbabel/XCOMET-XXL" | string;
  pythonPath: string;
  timeout: number;
}

const DEFAULT_CONFIG: XCometConfig = {
  model: "Unbabel/XCOMET-XL",
  pythonPath: "python3",
  timeout: 300000, // 300 seconds (5 minutes) - increased for model loading
};

/**
 * Execute Python script and return parsed JSON result
 */
async function executePython<T>(script: string, config: XCometConfig): Promise<T> {
  return new Promise((resolve, reject) => {
    const process = spawn(config.pythonPath, ["-c", script], {
      timeout: config.timeout,
      env: {
        ...globalThis.process.env,
        PYTHONWARNINGS: "ignore",  // Suppress Python warnings
        TOKENIZERS_PARALLELISM: "false",  // Avoid tokenizer warnings
      },
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Extract JSON from stdout (ignore any non-JSON output)
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          reject(new Error(`No JSON found in Python output: ${stdout}`));
          return;
        }
        const result = JSON.parse(jsonMatch[0]);
        resolve(result as T);
      } catch (parseError) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });

    process.on("error", (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });
  });
}

/**
 * Generate Python script for evaluation
 */
function generateEvaluateScript(
  source: string,
  translation: string,
  reference: string | undefined,
  model: string,
  useGpu: boolean = false
): string {
  const escapedSource = JSON.stringify(source);
  const escapedTranslation = JSON.stringify(translation);
  const escapedReference = reference ? JSON.stringify(reference) : "None";
  const gpus = useGpu ? 1 : 0;

  return `
import json
import sys
import os
import warnings

# Suppress all warnings
warnings.filterwarnings("ignore")
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Redirect stderr to suppress progress bars
class SuppressOutput:
    def write(self, x): pass
    def flush(self): pass

# Keep original stderr for errors only
original_stderr = sys.stderr

try:
    # Suppress tqdm and other progress output
    sys.stderr = SuppressOutput()

    from comet import download_model, load_from_checkpoint

    model_path = download_model("${model}")
    model = load_from_checkpoint(model_path)

    data = [{
        "src": ${escapedSource},
        "mt": ${escapedTranslation},
        ${reference ? `"ref": ${escapedReference}` : ""}
    }]

    output = model.predict(data, batch_size=1, gpus=${gpus}, num_workers=1)

    # Restore stderr
    sys.stderr = original_stderr

    result = {
        "score": float(output.scores[0]),
        "errors": [],
        "summary": ""
    }

    # Extract error spans if available
    if hasattr(output, 'metadata') and output.metadata:
        metadata = output.metadata[0]
        if 'error_spans' in metadata:
            for span in metadata['error_spans']:
                result["errors"].append({
                    "text": span.get("text", ""),
                    "start": span.get("start", 0),
                    "end": span.get("end", 0),
                    "severity": span.get("severity", "minor")
                })

    # Generate summary
    score = result["score"]
    error_count = len(result["errors"])
    if score >= 0.9:
        quality = "Excellent"
    elif score >= 0.7:
        quality = "Good"
    elif score >= 0.5:
        quality = "Fair"
    else:
        quality = "Poor"

    result["summary"] = f"{quality} quality (score: {score:.3f}) with {error_count} error(s) detected."

    print(json.dumps(result))

except ImportError as e:
    sys.stderr = original_stderr
    print(json.dumps({"error": f"Missing dependency: {str(e)}. Please install: pip install 'unbabel-comet>=2.2.0'"}))
    sys.exit(1)
except Exception as e:
    sys.stderr = original_stderr
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
}

/**
 * Generate Python script for batch evaluation (processes all pairs in a single model load)
 */
function generateBatchEvaluateScript(
  pairs: Array<{ source: string; translation: string; reference?: string }>,
  model: string,
  batchSize: number = 8,
  useGpu: boolean = false
): string {
  const escapedPairs = JSON.stringify(pairs);
  const gpus = useGpu ? 1 : 0;

  return `
import json
import sys
import os
import warnings

# Suppress all warnings
warnings.filterwarnings("ignore")
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Redirect stderr to suppress progress bars
class SuppressOutput:
    def write(self, x): pass
    def flush(self): pass

# Keep original stderr for errors only
original_stderr = sys.stderr

try:
    # Suppress tqdm and other progress output
    sys.stderr = SuppressOutput()

    from comet import download_model, load_from_checkpoint

    model_path = download_model("${model}")
    model = load_from_checkpoint(model_path)

    # Parse input pairs
    pairs = ${escapedPairs}

    # Build data list for batch processing
    data = []
    for pair in pairs:
        item = {
            "src": pair["source"],
            "mt": pair["translation"]
        }
        if pair.get("reference"):
            item["ref"] = pair["reference"]
        data.append(item)

    # Process all pairs in a single batch (model loaded once!)
    output = model.predict(data, batch_size=${batchSize}, gpus=${gpus}, num_workers=1)

    # Restore stderr
    sys.stderr = original_stderr

    # Build results
    results = []
    for i, score in enumerate(output.scores):
        result = {
            "index": i,
            "score": float(score),
            "errors": [],
            "error_count": 0,
            "has_critical_errors": False
        }

        # Extract error spans if available
        if hasattr(output, 'metadata') and output.metadata and i < len(output.metadata):
            metadata = output.metadata[i]
            if metadata and 'error_spans' in metadata:
                for span in metadata['error_spans']:
                    result["errors"].append({
                        "text": span.get("text", ""),
                        "start": span.get("start", 0),
                        "end": span.get("end", 0),
                        "severity": span.get("severity", "minor")
                    })
                    if span.get("severity") == "critical":
                        result["has_critical_errors"] = True
                result["error_count"] = len(result["errors"])

        results.append(result)

    # Calculate statistics
    total_score = sum(r["score"] for r in results)
    average_score = total_score / len(results) if results else 0
    good_count = sum(1 for r in results if r["score"] >= 0.7)
    critical_count = sum(1 for r in results if r["has_critical_errors"])

    output_data = {
        "average_score": average_score,
        "total_pairs": len(pairs),
        "results": results,
        "summary": f"Evaluated {len(pairs)} pairs. Average score: {average_score:.3f}. {good_count} good quality, {critical_count} with critical errors."
    }

    print(json.dumps(output_data))

except ImportError as e:
    sys.stderr = original_stderr
    print(json.dumps({"error": f"Missing dependency: {str(e)}. Please install: pip install 'unbabel-comet>=2.2.0'"}))
    sys.exit(1)
except Exception as e:
    sys.stderr = original_stderr
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
}

/**
 * xCOMET Service class for translation quality evaluation
 */
export class XCometService {
  private config: XCometConfig;

  constructor(config: Partial<XCometConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if xCOMET is available
   */
  async checkAvailability(): Promise<{ available: boolean; message: string }> {
    const script = `
import json
import warnings
warnings.filterwarnings("ignore")
try:
    from comet import download_model
    print(json.dumps({"available": True, "message": "xCOMET is available"}))
except ImportError:
    print(json.dumps({"available": False, "message": "unbabel-comet is not installed. Run: pip install 'unbabel-comet>=2.2.0'"}))
`;

    try {
      const result = await executePython<{ available: boolean; message: string }>(
        script,
        this.config
      );
      return result;
    } catch (error) {
      return {
        available: false,
        message: `Python execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Evaluate translation quality
   * @param useGpu - Use GPU for inference (faster if available)
   */
  async evaluate(
    source: string,
    translation: string,
    reference?: string,
    useGpu: boolean = false
  ): Promise<EvaluateOutput> {
    const script = generateEvaluateScript(source, translation, reference, this.config.model, useGpu);

    const result = await executePython<EvaluateOutput | { error: string }>(script, this.config);

    if ("error" in result) {
      throw new Error(result.error);
    }

    return result;
  }

  /**
   * Detect errors in translation
   * @param useGpu - Use GPU for inference (faster if available)
   */
  async detectErrors(
    source: string,
    translation: string,
    reference?: string,
    minSeverity: "minor" | "major" | "critical" = "minor",
    useGpu: boolean = false
  ): Promise<DetectErrorsOutput> {
    // First get evaluation result
    const evalResult = await this.evaluate(source, translation, reference, useGpu);

    // Filter errors by severity
    const severityOrder = { minor: 0, major: 1, critical: 2 };
    const minSeverityOrder = severityOrder[minSeverity];

    const filteredErrors = evalResult.errors.filter(
      (error) => severityOrder[error.severity] >= minSeverityOrder
    );

    // Count by severity
    const errorsBySeverity = { minor: 0, major: 0, critical: 0 };
    for (const error of filteredErrors) {
      errorsBySeverity[error.severity]++;
    }

    return {
      total_errors: filteredErrors.length,
      errors_by_severity: errorsBySeverity,
      errors: filteredErrors.map((e) => ({
        ...e,
        suggestion: undefined, // xCOMET doesn't provide suggestions
      })),
    };
  }

  /**
   * Batch evaluate multiple translation pairs
   * Uses optimized batch processing - model is loaded only once for all pairs
   * @param useGpu - Use GPU for inference (faster if available)
   */
  async batchEvaluate(
    pairs: Array<{ source: string; translation: string; reference?: string }>,
    batchSize: number = 8,
    useGpu: boolean = false
  ): Promise<BatchEvaluateOutput> {
    if (pairs.length === 0) {
      return {
        average_score: 0,
        total_pairs: 0,
        results: [],
        summary: "No pairs to evaluate.",
      };
    }

    // Generate batch processing script (model loaded once for all pairs)
    const script = generateBatchEvaluateScript(pairs, this.config.model, batchSize, useGpu);

    // Increase timeout for batch processing (base + per-pair time)
    // GPU is faster, so reduce per-pair timeout when using GPU
    const perPairTime = useGpu ? 1000 : 5000;
    const batchTimeout = this.config.timeout + pairs.length * perPairTime;

    const result = await executePython<BatchEvaluateOutput | { error: string }>(
      script,
      { ...this.config, timeout: batchTimeout }
    );

    if ("error" in result) {
      throw new Error(result.error);
    }

    return result;
  }
}

// Export singleton instance
export const xCometService = new XCometService();