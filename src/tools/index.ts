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
import { TOOL_DESCRIPTIONS } from "./descriptions.js";

/**
 * Common annotations for read-only evaluation tools
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Create a standardized tool response
 */
function createToolResponse(
  result: Record<string, unknown>,
  responseFormat: "json" | "markdown" | undefined,
  markdownTitle: string
) {
  const text =
    responseFormat === "markdown"
      ? formatAsMarkdown(result, markdownTitle)
      : JSON.stringify(result, null, 2);

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: result,
  };
}

/**
 * Create a standardized error response
 */
function createErrorResponse(error: unknown, context: string) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Error ${context}: ${errorMessage}`,
      },
    ],
    isError: true,
  };
}

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
      description: TOOL_DESCRIPTIONS.evaluate,
      inputSchema: {
        source: EvaluateInputSchema.shape.source,
        translation: EvaluateInputSchema.shape.translation,
        reference: EvaluateInputSchema.shape.reference,
        source_lang: EvaluateInputSchema.shape.source_lang,
        target_lang: EvaluateInputSchema.shape.target_lang,
        response_format: EvaluateInputSchema.shape.response_format,
        use_gpu: EvaluateInputSchema.shape.use_gpu,
      },
      outputSchema: {
        score: EvaluateOutputSchema.shape.score,
        errors: EvaluateOutputSchema.shape.errors,
        summary: EvaluateOutputSchema.shape.summary,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: EvaluateInput) => {
      try {
        const result = await xCometService.evaluate(
          params.source,
          params.translation,
          params.reference,
          params.use_gpu
        );
        return createToolResponse(result, params.response_format, "Translation Quality Evaluation");
      } catch (error) {
        return createErrorResponse(error, "evaluating translation");
      }
    }
  );

  // Tool: xcomet_detect_errors
  server.registerTool(
    "xcomet_detect_errors",
    {
      title: "Detect Translation Errors",
      description: TOOL_DESCRIPTIONS.detectErrors,
      inputSchema: {
        source: DetectErrorsInputSchema.shape.source,
        translation: DetectErrorsInputSchema.shape.translation,
        reference: DetectErrorsInputSchema.shape.reference,
        min_severity: DetectErrorsInputSchema.shape.min_severity,
        response_format: DetectErrorsInputSchema.shape.response_format,
        use_gpu: DetectErrorsInputSchema.shape.use_gpu,
      },
      outputSchema: {
        total_errors: DetectErrorsOutputSchema.shape.total_errors,
        errors_by_severity: DetectErrorsOutputSchema.shape.errors_by_severity,
        errors: DetectErrorsOutputSchema.shape.errors,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: DetectErrorsInput) => {
      try {
        const result = await xCometService.detectErrors(
          params.source,
          params.translation,
          params.reference,
          params.min_severity,
          params.use_gpu
        );
        return createToolResponse(result, params.response_format, "Translation Error Detection");
      } catch (error) {
        return createErrorResponse(error, "detecting errors");
      }
    }
  );

  // Tool: xcomet_batch_evaluate
  server.registerTool(
    "xcomet_batch_evaluate",
    {
      title: "Batch Evaluate Translations",
      description: TOOL_DESCRIPTIONS.batchEvaluate,
      inputSchema: {
        pairs: BatchEvaluateInputSchema.shape.pairs,
        source_lang: BatchEvaluateInputSchema.shape.source_lang,
        target_lang: BatchEvaluateInputSchema.shape.target_lang,
        response_format: BatchEvaluateInputSchema.shape.response_format,
        use_gpu: BatchEvaluateInputSchema.shape.use_gpu,
        batch_size: BatchEvaluateInputSchema.shape.batch_size,
      },
      outputSchema: {
        average_score: BatchEvaluateOutputSchema.shape.average_score,
        total_pairs: BatchEvaluateOutputSchema.shape.total_pairs,
        results: BatchEvaluateOutputSchema.shape.results,
        summary: BatchEvaluateOutputSchema.shape.summary,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: BatchEvaluateInput) => {
      try {
        const result = await xCometService.batchEvaluate(
          params.pairs,
          params.batch_size,
          params.use_gpu
        );
        return createToolResponse(result, params.response_format, "Batch Translation Evaluation");
      } catch (error) {
        return createErrorResponse(error, "in batch evaluation");
      }
    }
  );
}
