import { z } from "zod";

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
    .max(10000, "Source text must not exceed 10000 characters")
    .describe("Original source text"),
  translation: z
    .string()
    .min(1, "Translation text is required")
    .max(10000, "Translation text must not exceed 10000 characters")
    .describe("Translated text to evaluate"),
  reference: z
    .string()
    .max(10000)
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
    .max(10000)
    .describe("Original source text"),
  translation: z
    .string()
    .min(1, "Translation text is required")
    .max(10000)
    .describe("Translated text to analyze"),
  reference: z.string().max(10000).optional().describe("Optional reference translation"),
  min_severity: ErrorSeverity.default("minor").describe(
    "Minimum severity level to report (minor, major, critical)"
  ),
  response_format: ResponseFormat.default("json").describe("Output format"),
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
        suggestion: z.string().optional().describe("Suggested correction if available"),
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
    .max(100, "Maximum 100 pairs per batch")
    .describe("Array of translation pairs to evaluate"),
  source_lang: z.string().length(2).optional().describe("Source language code"),
  target_lang: z.string().length(2).optional().describe("Target language code"),
  response_format: ResponseFormat.default("json").describe("Output format"),
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
      })
    )
    .describe("Individual results for each pair"),
  summary: z.string().describe("Overall quality summary"),
});
export type BatchEvaluateOutput = z.infer<typeof BatchEvaluateOutputSchema>;
