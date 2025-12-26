/**
 * Tool descriptions for MCP server
 * Separated from tool registration logic for better readability
 */

export const TOOL_DESCRIPTIONS = {
  evaluate: `Evaluate the quality of a translation using xCOMET model.

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

  detectErrors: `Detect and categorize errors in a translation.

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

  batchEvaluate: `Evaluate multiple translation pairs in a batch.

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
};
