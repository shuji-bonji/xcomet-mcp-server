/**
 * xCOMET Service - Translation Quality Evaluation
 * Uses a persistent Python server for fast inference.
 */

import { getServerManager, shutdownServer, PythonServerManager } from "./python-server.js";
import type { EvaluateOutput, DetectErrorsOutput, BatchEvaluateOutput } from "../schemas/index.js";

/**
 * Configuration for xCOMET service
 */
export interface XCometConfig {
  model: "Unbabel/XCOMET-XL" | "Unbabel/XCOMET-XXL" | string;
  pythonPath?: string;
  timeout: number;
}

/**
 * Get model from environment variable or use default
 */
function getModel(): string {
  return process.env.XCOMET_MODEL || "Unbabel/XCOMET-XL";
}

/**
 * Models that require a reference translation
 */
const REFERENCE_REQUIRED_MODELS = [
  "Unbabel/wmt22-comet-da",
  "Unbabel/wmt20-comet-da",
  "Unbabel/wmt21-comet-da",
];

/**
 * Check if the given model requires a reference translation
 */
function modelRequiresReference(model: string): boolean {
  return REFERENCE_REQUIRED_MODELS.some(
    (refModel) => model.toLowerCase().includes(refModel.toLowerCase().replace("unbabel/", ""))
  );
}

const DEFAULT_CONFIG: XCometConfig = {
  get model() {
    return getModel();
  },
  timeout: 300000, // 5 minutes
};

/**
 * xCOMET Service class for translation quality evaluation
 * Uses a persistent Python server for efficient model inference.
 */
export class XCometService {
  private config: XCometConfig;
  private serverManager: PythonServerManager;

  constructor(config: Partial<XCometConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serverManager = getServerManager({
      pythonPath: config.pythonPath,
      model: this.config.model,
    });
  }

  /**
   * Check if xCOMET is available
   */
  async checkAvailability(): Promise<{ available: boolean; message: string; pythonPath?: string }> {
    try {
      const health = await this.serverManager.healthCheck();
      return {
        available: true,
        message: health.model_loaded
          ? `xCOMET is available (model: ${health.model_name})`
          : "xCOMET server is running, model will load on first request",
        pythonPath: this.serverManager.getPythonPath(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const pythonPath = this.serverManager.getPythonPath();

      let message: string;
      if (errorMessage.includes("ENOENT") || errorMessage.includes("spawn")) {
        message = `Python not found at "${pythonPath}". Please install Python 3.8+ and dependencies:\n` +
          `  1. Install Python: https://www.python.org/downloads/\n` +
          `  2. Install xCOMET: pip install 'unbabel-comet>=2.2.0'\n` +
          `  3. Install server deps: pip install fastapi uvicorn\n` +
          `  4. Set XCOMET_PYTHON_PATH if using pyenv/venv`;
      } else if (errorMessage.includes("No module named")) {
        message = `Missing Python dependencies. Run:\n` +
          `  ${pythonPath} -m pip install 'unbabel-comet>=2.2.0' fastapi uvicorn`;
      } else {
        message = `Python server failed: ${errorMessage}\n` +
          `Python path: ${pythonPath}\n` +
          `Tip: Set XCOMET_PYTHON_PATH to specify Python with dependencies installed`;
      }

      return {
        available: false,
        message,
        pythonPath,
      };
    }
  }

  /**
   * Get the Python path being used
   */
  getPythonPath(): string {
    return this.serverManager.getPythonPath();
  }

  /**
   * Get the model being used
   */
  getModel(): string {
    return this.serverManager.getModel();
  }

  /**
   * Evaluate translation quality
   */
  async evaluate(
    source: string,
    translation: string,
    reference?: string,
    useGpu: boolean = false
  ): Promise<EvaluateOutput> {
    // Validate reference requirement
    if (!reference && modelRequiresReference(this.config.model)) {
      throw new Error(
        `Model "${this.config.model}" requires a reference translation. ` +
        `Please provide the 'reference' parameter, or use an XCOMET model (e.g., Unbabel/XCOMET-XL) for referenceless evaluation.`
      );
    }

    const result = await this.serverManager.request<EvaluateOutput>("/evaluate", "POST", {
      source,
      translation,
      reference,
      use_gpu: useGpu,
    }, this.config.timeout);

    return result;
  }

  /**
   * Detect errors in translation
   */
  async detectErrors(
    source: string,
    translation: string,
    reference?: string,
    minSeverity: "minor" | "major" | "critical" = "minor",
    useGpu: boolean = false
  ): Promise<DetectErrorsOutput> {
    const result = await this.serverManager.request<DetectErrorsOutput>("/detect_errors", "POST", {
      source,
      translation,
      reference,
      min_severity: minSeverity,
      use_gpu: useGpu,
    }, this.config.timeout);

    return result;
  }

  /**
   * Batch evaluate multiple translation pairs
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

    // Validate reference requirement
    if (modelRequiresReference(this.config.model)) {
      const missingRefCount = pairs.filter((p) => !p.reference).length;
      if (missingRefCount > 0) {
        throw new Error(
          `Model "${this.config.model}" requires reference translations. ` +
          `${missingRefCount} of ${pairs.length} pairs are missing 'reference'. ` +
          `Please provide references for all pairs, or use an XCOMET model (e.g., Unbabel/XCOMET-XL) for referenceless evaluation.`
        );
      }
    }

    // Calculate timeout based on batch size
    const perPairTime = useGpu ? 1000 : 5000;
    const timeout = this.config.timeout + pairs.length * perPairTime;

    const result = await this.serverManager.request<BatchEvaluateOutput>("/batch_evaluate", "POST", {
      pairs,
      batch_size: batchSize,
      use_gpu: useGpu,
    }, timeout);

    return result;
  }
}

// Export singleton instance
export const xCometService = new XCometService();

// Export shutdown function for graceful termination
export { shutdownServer };
