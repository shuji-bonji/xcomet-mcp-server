import { z } from "zod";
import {
  MAX_TEXT_LENGTH,
  MAX_BATCH_PAIRS,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} from "../config/constants.js";

/**
 * Error severity levels according to MQM framework
 */
export const ErrorSeverity = z.enum(["minor", "major", "critical"]);
export type ErrorSeverity = z.infer<typeof ErrorSeverity>;

/**
 * Response format options
 */
export const ResponseFormat = z.enum(["json", "markdown"]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;

/**
 * GPU usage option - allows user/AI to choose CPU or GPU processing
 */
export const UseGpuSchema = z
  .boolean()
  .default(false)
  .describe("Use GPU for inference (faster if available). Default: false (CPU only)");

/**
 * Single translation pair for evaluation
 */
export const TranslationPairSchema = z.object({
  source: z.string().min(1).describe("Original source text"),
  translation: z.string().min(1).describe("Translated text to evaluate"),
  reference: z.string().optional().describe("Optional reference translation for comparison"),
});
export type TranslationPair = z.infer<typeof TranslationPairSchema>;

/**
 * Input schema for evaluate tool
 */
export const EvaluateInputSchema = z.object({
  source: z
    .string()
    .min(1, "Source text is required")
    .max(MAX_TEXT_LENGTH, `Source text must not exceed ${MAX_TEXT_LENGTH} characters`)
    .describe("Original source text"),
  translation: z
    .string()
    .min(1, "Translation text is required")
    .max(MAX_TEXT_LENGTH, `Translation text must not exceed ${MAX_TEXT_LENGTH} characters`)
    .describe("Translated text to evaluate"),
  reference: z
    .string()
    .max(MAX_TEXT_LENGTH)
    .optional()
    .describe("Optional reference translation for comparison"),
  source_lang: z
    .string()
    .length(2)
    .optional()
    .describe("Source language code (ISO 639-1, e.g., 'en', 'ja')"),
  target_lang: z
    .string()
    .length(2)
    .optional()
    .describe("Target language code (ISO 639-1, e.g., 'en', 'ja')"),
  response_format: ResponseFormat.default("json").describe(
    "Output format: 'json' for structured data or 'markdown' for human-readable"
  ),
  use_gpu: UseGpuSchema,
});
export type EvaluateInput = z.infer<typeof EvaluateInputSchema>;

/**
 * Output schema for evaluate tool
 */
export const EvaluateOutputSchema = z.object({
  score: z.number().min(0).max(1).describe("Quality score between 0 and 1"),
  errors: z
    .array(
      z.object({
        text: z.string().describe("Error span text"),
        start: z.number().describe("Start position in translation"),
        end: z.number().describe("End position in translation"),
        severity: ErrorSeverity.describe("Error severity level"),
      })
    )
    .describe("Detected error spans"),
  summary: z.string().describe("Human-readable quality summary"),
});
export type EvaluateOutput = z.infer<typeof EvaluateOutputSchema>;

/**
 * Input schema for detect_errors tool
 */
export const DetectErrorsInputSchema = z.object({
  source: z
    .string()
    .min(1, "Source text is required")
    .max(MAX_TEXT_LENGTH)
    .describe("Original source text"),
  translation: z
    .string()
    .min(1, "Translation text is required")
    .max(MAX_TEXT_LENGTH)
    .describe("Translated text to analyze"),
  reference: z.string().max(MAX_TEXT_LENGTH).optional().describe("Optional reference translation"),
  min_severity: ErrorSeverity.default("minor").describe(
    "Minimum severity level to report (minor, major, critical)"
  ),
  response_format: ResponseFormat.default("json").describe("Output format"),
  use_gpu: UseGpuSchema,
});
export type DetectErrorsInput = z.infer<typeof DetectErrorsInputSchema>;

/**
 * Output schema for detect_errors tool
 */
export const DetectErrorsOutputSchema = z.object({
  total_errors: z.number().describe("Total number of errors detected"),
  errors_by_severity: z
    .object({
      minor: z.number(),
      major: z.number(),
      critical: z.number(),
    })
    .describe("Error count by severity"),
  errors: z
    .array(
      z.object({
        text: z.string(),
        start: z.number(),
        end: z.number(),
        severity: ErrorSeverity,
      })
    )
    .describe("Detailed error list"),
});
export type DetectErrorsOutput = z.infer<typeof DetectErrorsOutputSchema>;

/**
 * Input schema for batch_evaluate tool
 */
export const BatchEvaluateInputSchema = z.object({
  pairs: z
    .array(TranslationPairSchema)
    .min(1, "At least one translation pair is required")
    .max(MAX_BATCH_PAIRS, `Maximum ${MAX_BATCH_PAIRS} pairs per batch`)
    .describe("Array of translation pairs to evaluate"),
  source_lang: z.string().length(2).optional().describe("Source language code"),
  target_lang: z.string().length(2).optional().describe("Target language code"),
  response_format: ResponseFormat.default("json").describe("Output format"),
  use_gpu: UseGpuSchema,
  batch_size: z
    .number()
    .int()
    .min(MIN_BATCH_SIZE)
    .max(MAX_BATCH_SIZE)
    .default(DEFAULT_BATCH_SIZE)
    .describe(`Batch size for GPU processing (${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE}). Larger = faster but uses more memory. Default: ${DEFAULT_BATCH_SIZE}`),
});
export type BatchEvaluateInput = z.infer<typeof BatchEvaluateInputSchema>;

/**
 * Output schema for batch_evaluate tool
 */
export const BatchEvaluateOutputSchema = z.object({
  average_score: z.number().min(0).max(1).describe("Average quality score across all pairs"),
  total_pairs: z.number().describe("Total number of evaluated pairs"),
  results: z
    .array(
      z.object({
        index: z.number().describe("Index of the translation pair"),
        score: z.number().min(0).max(1),
        error_count: z.number(),
        has_critical_errors: z.boolean(),
        errors: z
          .array(
            z.object({
              text: z.string().describe("Error span text"),
              start: z.number().describe("Start position in translation"),
              end: z.number().describe("End position in translation"),
              severity: ErrorSeverity.describe("Error severity level"),
            })
          )
          .describe("Detected error spans for this pair"),
      })
    )
    .describe("Individual results for each pair"),
  summary: z.string().describe("Overall quality summary"),
});
export type BatchEvaluateOutput = z.infer<typeof BatchEvaluateOutputSchema>;
