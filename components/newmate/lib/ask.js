/**
 * The model's option-asking tool, mirroring Newmark's own ask design.
 *
 * Newmark's conversation UI renders a question as an option block: the question, 2+ labelled
 * choices each with an optional description, and a free-text field for an answer the choices do
 * not cover (DESKTOP/src/ui/index.html ~L13342-L13414). The answer is not a chat message: it is
 * the result of the tool call that asked, so the SAME run continues with the user's choice.
 *
 * This module owns the tool surface only. The waiting itself lives in the NewMate component
 * (createNewMate's ask/answerQuestion/pendingQuestion), because the page route and the run share
 * that one instance; the tool definition is a thin adapter so a gate can drive it directly.
 */

/** The model-facing tool name. */
export const NEWMATE_ASK_TOOL = 'newmate_ask';
/** Newmark's option block accepts a short list; the model does not get to render a menu. */
export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 6;
export const ASK_QUESTION_MAX_CHARS = 500;
export const ASK_LABEL_MAX_CHARS = 120;
export const ASK_DESCRIPTION_MAX_CHARS = 240;
export const ASK_MANUAL_MAX_CHARS = 2000;

/**
 * The tool definition handed to the registry. `mate` is the NewMate kernel instance: its
 * `ask` blocks until the page answers and resolves with the answer, or with a named abort
 * when the run is cancelled. No model argument can widen the option list or skip validation.
 */
export function createAskTool(mate) {
  return {
    name: NEWMATE_ASK_TOOL,
    description: [
      'Ask the user to choose, in Newmark option-block style: a question plus ' + ASK_MIN_OPTIONS + '-' + ASK_MAX_OPTIONS + ' labelled options, each optionally described, and a free-text field the user may use instead.',
      'Use it when a decision genuinely needs the user (a fork in the work, a preference, a destructive choice); do not use it for confirmation of something they already asked for, and never in an autonomous check-in (the tool is not offered there).',
      'The call blocks until the user answers; its result is the chosen label or the typed text.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: ASK_QUESTION_MAX_CHARS, description: 'The decision to ask about, in one or two sentences.' },
        options: {
          type: 'array',
          minItems: ASK_MIN_OPTIONS,
          maxItems: ASK_MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1, maxLength: ASK_LABEL_MAX_CHARS },
              description: { type: 'string', maxLength: ASK_DESCRIPTION_MAX_CHARS },
            },
            required: ['label'],
            additionalProperties: false,
          },
          description: 'The choices to show, in the order they should appear.',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    execute: (args, execution) => mate.ask(args, execution),
  };
}
