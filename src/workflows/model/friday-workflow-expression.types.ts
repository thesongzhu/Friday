// ─── Expression AST ───

export type FridayExprNode =
  | FridayExprLiteral
  | FridayExprRef
  | FridayExprBinaryOp
  | FridayExprUnaryOp;

export interface FridayExprLiteral {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface FridayExprRef {
  kind: "ref";
  path: string[];
}

export interface FridayExprBinaryOp {
  kind: "binary";
  op: "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||";
  left: FridayExprNode;
  right: FridayExprNode;
}

export interface FridayExprUnaryOp {
  kind: "unary";
  op: "!";
  operand: FridayExprNode;
}

// ─── Expression Context (variables available during evaluation) ───

export interface FridayExpressionStepContext {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
  error?: { code: string; message: string };
}

export interface FridayExpressionContext {
  inputs: Record<string, unknown>;
  steps: Record<string, FridayExpressionStepContext>;
  env?: Record<string, unknown>;
}

// ─── Expression Evaluator Contract ───

export interface FridayExpressionEvaluator {
  /** Parse an expression string into an AST. Throws on syntax error. */
  parse(expr: string): FridayExprNode;
  /** Evaluate a parsed AST against a context. Returns a primitive value. */
  evaluate(ast: FridayExprNode, ctx: FridayExpressionContext): unknown;
  /** Convenience: parse + evaluate in one call. */
  exec(expr: string, ctx: FridayExpressionContext): unknown;
}
