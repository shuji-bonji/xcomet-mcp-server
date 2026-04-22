/**
 * xCOMET Service - Translation Quality Evaluation
 * Uses a persistent Python server for fast inference.
 */

import type { PythonServerManager } from "./python-server.js";
import { getServerManager, shutdownServer } from "./python-server.js";
import type { EvaluateOutput, DetectErrorsOutput, BatchEvaluateOutput } from "../schemas/index.js";
import {
  XCOMET_DEFAULT_MODEL,
  XCOMET_DEFAULT_TIMEOUT_MS,
  XCOMET_GPU_PER_PAIR_TIME_MS,
  XCOMET_CPU_PER_PAIR_TIME_MS,
  REFERENCE_REQUIRED_MODELS,
} from "../config/constants.js";
import {
  XCometServiceErrors,
  AvailabilityErrors,
  InfoMessages,
} from "../config/errors.js";

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
  return process.env.XCOMET_MODEL || XCOMET_DEFAULT_MODEL;
}

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
  timeout: XCOMET_DEFAULT_TIMEOUT_MS,
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
          ? InfoMessages.available(health.model_name)
          : InfoMessages.serverRunning,
        pythonPath: this.serverManager.getPythonPath(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const pythonPath = this.serverManager.getPythonPath();

      let message: string;
      if (errorMessage.includes("ENOENT") || errorMessage.includes("spawn")) {
        message = AvailabilityErrors.pythonNotFound(pythonPath);
      } else if (errorMessage.includes("No module named")) {
        message = AvailabilityErrors.missingDependencies(pythonPath);
      } else {
        message = AvailabilityErrors.serverFailed(errorMessage, pythonPath);
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
      throw new Error(XCometServiceErrors.referenceRequired(this.config.model));
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
          XCometServiceErrors.batchReferenceRequired(this.config.model, missingRefCount, pairs.length)
        );
      }
    }

    // Calculate timeout based on batch size
    const perPairTime = useGpu ? XCOMET_GPU_PER_PAIR_TIME_MS : XCOMET_CPU_PER_PAIR_TIME_MS;
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
