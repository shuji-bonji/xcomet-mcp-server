import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EvaluateInputSchema,
  EvaluateOutputSchema,
  DetectErrorsInputSchema,
  DetectErrorsOutputSchema,
  BatchEvaluateInputSchema,
  BatchEvaluateOutputSchema,
  type EvaluateInput,
  type DetectErrorsInput,
  type BatchEvaluateInput,
} from "../schemas/index.js";
import { xCometService } from "../services/xcomet.js";

/**
 * Format output as markdown
 */
function formatAsMarkdown(data: Record<string, unknown>, title: string): string {
  let md = `## ${title}\n\n`;

  if ("score" in data && typeof data.score === "number") {
    const score = data.score;
    const stars = score >= 0.9 ? "⭐⭐⭐⭐⭐" : score >= 0.7 ? "⭐⭐⭐⭐" : score >= 0.5 ? "⭐⭐⭐" : score >= 0.3 ? "⭐⭐" : "⭐";
    md += `**Quality Score:** ${(score * 100).toFixed(1)}% ${stars}\n\n`;
  }

  if ("summary" in data && typeof data.summary === "string") {
    md += `**Summary:** ${data.summary}\n\n`;
  }

  if ("errors" in data && Array.isArray(data.errors) && data.errors.length > 0) {
    md += `### Detected Errors\n\n`;
    md += `| Severity | Text | Position |\n`;
    md += `|----------|------|----------|\n`;
    for (const error of data.errors) {
      const e = error as { severity: string; text: string; start: number; end: number };
      const severityEmoji = e.severity === "critical" ? "🔴" : e.severity === "major" ? "🟠" : "🟡";
      md += `| ${severityEmoji} ${e.severity} | ${e.text} | ${e.start}-${e.end} |\n`;
    }
    md += "\n";
  }

  if ("results" in data && Array.isArray(data.results)) {
    md += `### Batch Results\n\n`;
    md += `| # | Score | Errors | Critical |\n`;
    md += `|---|-------|--------|----------|\n`;
    for (const r of data.results) {
      const result = r as { index: number; score: number; error_count: number; has_critical_errors: boolean };
      md += `| ${result.index + 1} | ${(result.score * 100).toFixed(1)}% | ${result.error_count} | ${result.has_critical_errors ? "⚠️ Yes" : "✓ No"} |\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Register all xCOMET tools to the MCP server
 */
export function registerTools(server: McpServer): void {
  // Tool: xcomet_evaluate
  server.registerTool(
    "xcomet_evaluate",
    {
      title: "Evaluate Translation Quality",
      description: `Evaluate the quality of a translation using xCOMET model.

This tool analyzes a source text and its translation, providing:
- A quality score between 0 and 1 (higher is better)
- Detected error spans with severity levels (minor/major/critical)
- A human-readable quality summary

Args:
  - source (string): Original source text to translate from
  - translation (string): Translated text to evaluate
  - reference (string, optional): Reference translation for comparison
  - source_lang (string, optional): Source language code (ISO 639-1)
  - target_lang (string, optional): Target language code (ISO 639-1)
  - response_format ('json' | 'markdown'): Output format (default: 'json')

Returns:
  For JSON format:
  {
    "score": number,      // Quality score 0-1
    "errors": [           // Detected errors
      {
        "text": string,
        "start": number,
        "end": number,
        "severity": "minor" | "major" | "critical"
      }
    ],
    "summary": string     // Human-readable summary
  }

Examples:
  - Evaluate EN→JA translation quality
  - Check if MT output needs post-editing
  - Compare translation against reference`,
      inputSchema: {
        source: EvaluateInputSchema.shape.source,
        translation: EvaluateInputSchema.shape.translation,
        reference: EvaluateInputSchema.shape.reference,
        source_lang: EvaluateInputSchema.shape.source_lang,
        target_lang: EvaluateInputSchema.shape.target_lang,
        response_format: EvaluateInputSchema.shape.response_format,
      },
      outputSchema: {
        score: EvaluateOutputSchema.shape.score,
        errors: EvaluateOutputSchema.shape.errors,
        summary: EvaluateOutputSchema.shape.summary,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: EvaluateInput) => {
      try {
        const result = await xCometService.evaluate(
          params.source,
          params.translation,
          params.reference
        );

        const text =
          params.response_format === "markdown"
            ? formatAsMarkdown(result, "Translation Quality Evaluation")
            : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error evaluating translation: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: xcomet_detect_errors
  server.registerTool(
    "xcomet_detect_errors",
    {
      title: "Detect Translation Errors",
      description: `Detect and categorize errors in a translation.

This tool focuses on error detection, providing detailed information about
translation errors with their severity levels and positions.

Args:
  - source (string): Original source text
  - translation (string): Translated text to analyze
  - reference (string, optional): Reference translation
  - min_severity ('minor' | 'major' | 'critical'): Minimum severity to report (default: 'minor')
  - response_format ('json' | 'markdown'): Output format (default: 'json')

Returns:
  {
    "total_errors": number,
    "errors_by_severity": {
      "minor": number,
      "major": number,
      "critical": number
    },
    "errors": [
      {
        "text": string,
        "start": number,
        "end": number,
        "severity": "minor" | "major" | "critical",
        "suggestion": string | null
      }
    ]
  }

Examples:
  - Find critical errors before publication
  - Identify areas needing post-editing
  - Quality gate for MT output`,
      inputSchema: {
        source: DetectErrorsInputSchema.shape.source,
        translation: DetectErrorsInputSchema.shape.translation,
        reference: DetectErrorsInputSchema.shape.reference,
        min_severity: DetectErrorsInputSchema.shape.min_severity,
        response_format: DetectErrorsInputSchema.shape.response_format,
      },
      outputSchema: {
        total_errors: DetectErrorsOutputSchema.shape.total_errors,
        errors_by_severity: DetectErrorsOutputSchema.shape.errors_by_severity,
        errors: DetectErrorsOutputSchema.shape.errors,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: DetectErrorsInput) => {
      try {
        const result = await xCometService.detectErrors(
          params.source,
          params.translation,
          params.reference,
          params.min_severity
        );

        const text =
          params.response_format === "markdown"
            ? formatAsMarkdown(result, "Translation Error Detection")
            : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error detecting errors: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: xcomet_batch_evaluate
  server.registerTool(
    "xcomet_batch_evaluate",
    {
      title: "Batch Evaluate Translations",
      description: `Evaluate multiple translation pairs in a batch.

This tool processes multiple source-translation pairs and provides
aggregate statistics along with individual results.

Args:
  - pairs (array): Array of translation pairs, each with:
    - source (string): Original source text
    - translation (string): Translated text
    - reference (string, optional): Reference translation
  - source_lang (string, optional): Source language code
  - target_lang (string, optional): Target language code
  - response_format ('json' | 'markdown'): Output format (default: 'json')

Returns:
  {
    "average_score": number,
    "total_pairs": number,
    "results": [
      {
        "index": number,
        "score": number,
        "error_count": number,
        "has_critical_errors": boolean
      }
    ],
    "summary": string
  }

Examples:
  - Evaluate entire translated document
  - Compare MT system quality across test set
  - Identify segments needing attention`,
      inputSchema: {
        pairs: BatchEvaluateInputSchema.shape.pairs,
        source_lang: BatchEvaluateInputSchema.shape.source_lang,
        target_lang: BatchEvaluateInputSchema.shape.target_lang,
        response_format: BatchEvaluateInputSchema.shape.response_format,
      },
      outputSchema: {
        average_score: BatchEvaluateOutputSchema.shape.average_score,
        total_pairs: BatchEvaluateOutputSchema.shape.total_pairs,
        results: BatchEvaluateOutputSchema.shape.results,
        summary: BatchEvaluateOutputSchema.shape.summary,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: BatchEvaluateInput) => {
      try {
        const result = await xCometService.batchEvaluate(params.pairs);

        const text =
          params.response_format === "markdown"
            ? formatAsMarkdown(result, "Batch Translation Evaluation")
            : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text", text }],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error in batch evaluation: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
