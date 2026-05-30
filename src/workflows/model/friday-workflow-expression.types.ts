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
  op:
    | "=="
    | "!="
    | ">"
    | "<"
    | ">="
    | "<="
    | "&&"
    | "||"
    // Arithmetic / string-concat. "+" does numeric addition ONLY when BOTH
    // operands are typeof "number"; for ANY other operand (string, null,
    // boolean, object) it string-concatenates (so null + 5 => "5", not 5 —
    // deliberately NOT JS "+" semantics; the rule is one clear branch). "- * /
    // %" always Number()-coerce both operands (like the ordering comparisons).
    // NOTE: binary "-" needs surrounding spaces ("$a - $b"); "-" is also a
    // valid ref-name char (hyphenated step IDs like $steps.s3-csv), so "$a-$b"
    // parses as a ref, not subtraction.
    | "+"
    | "-"
    | "*"
    | "/"
    | "%";
  left: FridayExprNode;
  right: FridayExprNode;
}

export interface FridayExprUnaryOp {
  kind: "unary";
  // "!" logical negation (boolean, loose precedence); "-" numeric negation
  // (tight precedence, binds below multiplicative).
  op: "!" | "-";
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
