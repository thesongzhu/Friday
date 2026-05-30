import { FridayDomainError } from "#errors";
import type {
  FridayExpressionContext,
  FridayExprNode,
  FridayExpressionEvaluator as IFridayExpressionEvaluator,
} from "../model/friday-workflow-expression.types.js";

export type { IFridayExpressionEvaluator as FridayExpressionEvaluator };

const MAX_EXPR_LENGTH = 4096;
const MAX_DEPTH = 32;

// ─── Token types ───

type TokenKind =
  | "REF"
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "OP"
  | "LPAREN"
  | "RPAREN"
  | "NOT"
  | "EOF";

interface Token {
  kind: TokenKind;
  value: string;
}

// ─── Tokenizer ───

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i]!)) {
      i++;
      continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (
      two === "==" ||
      two === "!=" ||
      two === ">=" ||
      two === "<=" ||
      two === "&&" ||
      two === "||"
    ) {
      tokens.push({ kind: "OP", value: two });
      i += 2;
      continue;
    }

    // Single-char operators (comparison + arithmetic). "-" is always an
    // operator token here; numeric negation is handled in the parser
    // (unaryMinus) so subtraction `$a - $b` and negation `-5` both work.
    const ch = expr[i]!;
    if (
      ch === ">" ||
      ch === "<" ||
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "%"
    ) {
      tokens.push({ kind: "OP", value: ch });
      i++;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "NOT", value: "!" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "LPAREN", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "RPAREN", value: ")" });
      i++;
      continue;
    }

    // Ref: $identifier.path
    if (ch === "$") {
      let ref = "";
      i++; // skip $
      while (i < expr.length && /[a-zA-Z0-9_.-]/.test(expr[i]!)) {
        ref += expr[i];
        i++;
      }
      if (ref === "") {
        throw new FridayDomainError("EXPRESSION_PARSE_ERROR", "EXPRESSION_PARSE_ERROR: expected identifier after '$'", { httpStatus: 400 });
      }
      tokens.push({ kind: "REF", value: ref });
      continue;
    }

    // String literal (double or single quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\") {
          i++;
          if (i < expr.length) {
            str += expr[i];
            i++;
          }
        } else {
          str += expr[i];
          i++;
        }
      }
      if (i >= expr.length) {
        throw new FridayDomainError("EXPRESSION_PARSE_ERROR", "EXPRESSION_PARSE_ERROR: unterminated string literal", { httpStatus: 400 });
      }
      i++; // skip closing quote
      tokens.push({ kind: "STRING", value: str });
      continue;
    }

    // Number literal (digits only; a leading "-" is a unary/binary operator
    // token resolved by the parser, not part of the number token).
    if (/[0-9]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        num += expr[i];
        i++;
      }
      tokens.push({ kind: "NUMBER", value: num });
      continue;
    }

    // Keywords: true, false, null
    if (/[a-zA-Z]/.test(ch)) {
      let word = "";
      while (i < expr.length && /[a-zA-Z_]/.test(expr[i]!)) {
        word += expr[i];
        i++;
      }
      if (word === "true" || word === "false") {
        tokens.push({ kind: "BOOLEAN", value: word });
      } else if (word === "null") {
        tokens.push({ kind: "NULL", value: "null" });
      } else {
        throw new FridayDomainError(
          "EXPRESSION_PARSE_ERROR",
          `EXPRESSION_PARSE_ERROR: unexpected identifier '${word}'; use $${word} for references`,
          { httpStatus: 400 },
        );
      }
      continue;
    }

    throw new FridayDomainError(
      "EXPRESSION_PARSE_ERROR",
      `EXPRESSION_PARSE_ERROR: unexpected character '${ch}' at position ${i}`,
      { httpStatus: 400 },
    );
  }

  tokens.push({ kind: "EOF", value: "" });
  return tokens;
}

// ─── Parser (recursive descent) ───

function parseExpr(tokens: Token[]): FridayExprNode {
  let pos = 0;
  let depth = 0;

  function peek(): Token {
    return tokens[pos] ?? { kind: "EOF", value: "" };
  }

  function advance(): Token {
    const t = tokens[pos]!;
    pos++;
    return t;
  }

  function expect(kind: TokenKind): Token {
    const t = peek();
    if (t.kind !== kind) {
      throw new FridayDomainError(
        "EXPRESSION_PARSE_ERROR",
        `EXPRESSION_PARSE_ERROR: expected ${kind} but got ${t.kind} '${t.value}'`,
        { httpStatus: 400 },
      );
    }
    return advance();
  }

  function checkDepth(): void {
    depth++;
    if (depth > MAX_DEPTH) {
      throw new FridayDomainError("EXPRESSION_DEPTH_EXCEEDED", "EXPRESSION_DEPTH_EXCEEDED: maximum nesting depth of 32 exceeded", { httpStatus: 400 });
    }
  }

  // expr = logical_or
  function expr(): FridayExprNode {
    checkDepth();
    const result = logicalOr();
    depth--;
    return result;
  }

  // logical_or = logical_and ( "||" logical_and )*
  function logicalOr(): FridayExprNode {
    let left = logicalAnd();
    while (peek().kind === "OP" && peek().value === "||") {
      advance();
      const right = logicalAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  // logical_and = not_expr ( "&&" not_expr )*
  function logicalAnd(): FridayExprNode {
    let left = notExpr();
    while (peek().kind === "OP" && peek().value === "&&") {
      advance();
      const right = notExpr();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  // not_expr = "!" not_expr | compare
  function notExpr(): FridayExprNode {
    if (peek().kind === "NOT") {
      advance();
      const operand = notExpr();
      return { kind: "unary", op: "!", operand };
    }
    return compare();
  }

  // compare = additive ( CMP_OP additive )?
  // NOTE: additive/multiplicative/unaryMinus sit BELOW compare so that a pure
  // comparison/logical expression (a workflow condition) with no arithmetic
  // operators parses to the IDENTICAL AST as before this change — additive and
  // multiplicative pass straight through to primary when no +,-,*,/,% appears.
  function compare(): FridayExprNode {
    const left = additive();
    const t = peek();
    if (
      t.kind === "OP" &&
      (t.value === "==" ||
        t.value === "!=" ||
        t.value === ">" ||
        t.value === "<" ||
        t.value === ">=" ||
        t.value === "<=")
    ) {
      advance();
      const right = additive();
      return {
        kind: "binary",
        op: t.value as "==" | "!=" | ">" | "<" | ">=" | "<=",
        left,
        right,
      };
    }
    return left;
  }

  // additive = multiplicative ( ("+"|"-") multiplicative )*   (left-assoc)
  function additive(): FridayExprNode {
    let left = multiplicative();
    while (peek().kind === "OP" && (peek().value === "+" || peek().value === "-")) {
      const op = advance().value as "+" | "-";
      const right = multiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  // multiplicative = unaryMinus ( ("*"|"/"|"%") unaryMinus )*   (left-assoc)
  function multiplicative(): FridayExprNode {
    let left = unaryMinus();
    while (
      peek().kind === "OP" &&
      (peek().value === "*" || peek().value === "/" || peek().value === "%")
    ) {
      const op = advance().value as "*" | "/" | "%";
      const right = unaryMinus();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  // unaryMinus = "-" unaryMinus | primary   (numeric negation; tight binding)
  function unaryMinus(): FridayExprNode {
    if (peek().kind === "OP" && peek().value === "-") {
      checkDepth();
      advance();
      const operand = unaryMinus();
      depth--;
      return { kind: "unary", op: "-", operand };
    }
    return primary();
  }

  // primary = ref | literal | "(" expr ")"
  function primary(): FridayExprNode {
    const t = peek();

    if (t.kind === "REF") {
      advance();
      return { kind: "ref", path: t.value.split(".") };
    }

    if (t.kind === "STRING") {
      advance();
      return { kind: "literal", value: t.value };
    }

    if (t.kind === "NUMBER") {
      advance();
      return { kind: "literal", value: Number(t.value) };
    }

    if (t.kind === "BOOLEAN") {
      advance();
      return { kind: "literal", value: t.value === "true" };
    }

    if (t.kind === "NULL") {
      advance();
      return { kind: "literal", value: null };
    }

    if (t.kind === "LPAREN") {
      advance();
      const inner = expr();
      expect("RPAREN");
      return inner;
    }

    throw new FridayDomainError(
      "EXPRESSION_PARSE_ERROR",
      `EXPRESSION_PARSE_ERROR: unexpected token ${t.kind} '${t.value}'`,
      { httpStatus: 400 },
    );
  }

  const result = expr();

  if (peek().kind !== "EOF") {
    const leftover = peek();
    throw new FridayDomainError(
      "EXPRESSION_PARSE_ERROR",
      `EXPRESSION_PARSE_ERROR: unexpected token ${leftover.kind} '${leftover.value}' after expression`,
      { httpStatus: 400 },
    );
  }

  return result;
}

// ─── Evaluator ───

// Concat coercion for "+" when at least one operand is not a number.
// Explicit + predictable: null/undefined → "" (so a missing ref in
// `$a + " " + $b` does not emit the literal text "null"/"undefined"),
// objects/arrays → JSON, everything else → String().
function stringifyOperand(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function evaluateNode(
  node: FridayExprNode,
  ctx: FridayExpressionContext,
): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;

    case "ref": {
      // Resolve path against context: first segment selects the top-level object
      const [root, ...rest] = node.path;
      let target: unknown;
      if (root === "inputs") {
        target = ctx.inputs;
      } else if (root === "steps") {
        target = ctx.steps;
      } else if (root === "env") {
        target = ctx.env;
      } else {
        return undefined;
      }

      for (const segment of rest) {
        // Reject unsafe path segments that could leak prototype internals
        if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
          throw new FridayDomainError(
            "EXPRESSION_UNSAFE_PATH_ACCESS",
            `EXPRESSION_UNSAFE_PATH_ACCESS: path segment '${segment}' is not allowed`,
            { httpStatus: 400 },
          );
        }
        if (target == null || typeof target !== "object") {
          return undefined;
        }
        target = (target as Record<string, unknown>)[segment];
      }
      return target;
    }

    case "binary": {
      // Short-circuit for logical operators
      if (node.op === "&&") {
        const left = evaluateNode(node.left, ctx);
        if (!left) return left;
        return evaluateNode(node.right, ctx);
      }
      if (node.op === "||") {
        const left = evaluateNode(node.left, ctx);
        if (left) return left;
        return evaluateNode(node.right, ctx);
      }

      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);

      switch (node.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return Number(left) > Number(right);
        case "<":
          return Number(left) < Number(right);
        case ">=":
          return Number(left) >= Number(right);
        case "<=":
          return Number(left) <= Number(right);
        // Arithmetic / concat. Coercion rule is explicit and documented:
        // "+" does numeric addition only when BOTH operands are numbers,
        // otherwise string concatenation (String(left)+String(right));
        // "- * / %" always Number()-coerce both operands (consistent with the
        // ordering comparison operators above).
        case "+":
          if (typeof left === "number" && typeof right === "number") {
            return left + right;
          }
          return `${stringifyOperand(left)}${stringifyOperand(right)}`;
        case "-":
          return Number(left) - Number(right);
        case "*":
          return Number(left) * Number(right);
        case "/":
          return Number(left) / Number(right);
        case "%":
          return Number(left) % Number(right);
      }
      break;
    }

    case "unary": {
      const operand = evaluateNode(node.operand, ctx);
      if (node.op === "-") {
        return -Number(operand);
      }
      return !operand;
    }
  }
}

// ─── Factory ───

export function createFridayExpressionEvaluator(): IFridayExpressionEvaluator {
  return {
    parse(expr: string): FridayExprNode {
      if (expr.length > MAX_EXPR_LENGTH) {
        throw new FridayDomainError(
          "EXPRESSION_TOO_LONG",
          `EXPRESSION_TOO_LONG: expression length ${expr.length} exceeds maximum ${MAX_EXPR_LENGTH}`,
          { httpStatus: 400 },
        );
      }
      const tokens = tokenize(expr);
      return parseExpr(tokens);
    },

    evaluate(ast: FridayExprNode, ctx: FridayExpressionContext): unknown {
      return evaluateNode(ast, ctx);
    },

    exec(expr: string, ctx: FridayExpressionContext): unknown {
      const ast = this.parse(expr);
      return this.evaluate(ast, ctx);
    },
  };
}
