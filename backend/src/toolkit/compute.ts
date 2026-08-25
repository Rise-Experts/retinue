/**
 * Time and arithmetic — REQ-039 (#188).
 *
 * The two things a model is reliably bad at and a two-line function is reliably good at. Both are pure, so both
 * are here as functions and the tool envelopes over them are trivial.
 */

/**
 * Evaluate an arithmetic expression, without `eval`.
 *
 * `eval` on a string a model produced is remote code execution with extra steps, and `new Function` is the same
 * thing wearing a hat. So this is a small recursive-descent parser over a closed grammar: numbers, `+ - * / % ^`,
 * parentheses, unary minus, and a fixed set of named functions and constants. Anything else is a syntax error
 * rather than a silent success.
 *
 * Precision is IEEE-754 double, like every other number in this runtime. It is not a decimal library, and
 * `0.1 + 0.2` is documented rather than hidden, because a tool that quietly rounds is a tool that disagrees with
 * the spreadsheet the person is comparing it against.
 */
export type CalculationResult =
  | { readonly ok: true; readonly expression: string; readonly value: number }
  | { readonly ok: false; readonly expression: string; readonly reason: string };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
  sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  min: Math.min, max: Math.max, pow: Math.pow,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export const MAX_EXPRESSION_CHARS = 500;

export const calculate = (expression: string): CalculationResult => {
  if (expression.trim() === "") return { ok: false, expression, reason: "The expression is empty." };
  if (expression.length > MAX_EXPRESSION_CHARS) {
    return { ok: false, expression, reason: `Expressions are limited to ${MAX_EXPRESSION_CHARS} characters.` };
  }

  const tokens = expression.toLowerCase().match(/\d+\.?\d*|[a-z_]\w*|[+\-*/%^(),]|\S/g);
  if (tokens === null) return { ok: false, expression, reason: "There is nothing to evaluate." };

  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  const fail = (reason: string): never => {
    throw new SyntaxError(reason);
  };

  // expression := term (('+' | '-') term)*
  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      const operator = peek();
      if (operator !== "+" && operator !== "-") return value;
      take();
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
  };

  // term := power (('*' | '/' | '%') power)*
  const parseTerm = (): number => {
    let value = parsePower();
    for (;;) {
      const operator = peek();
      if (operator !== "*" && operator !== "/" && operator !== "%") return value;
      take();
      const right = parsePower();
      if ((operator === "/" || operator === "%") && right === 0) fail("division by zero");
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
  };

  // power := unary ('^' power)?   -- right-associative, so 2^3^2 is 512 and not 64.
  const parsePower = (): number => {
    const base = parseUnary();
    if (peek() !== "^") return base;
    take();
    return base ** parsePower();
  };

  const parseUnary = (): number => {
    if (peek() === "-") {
      take();
      return -parseUnary();
    }
    if (peek() === "+") {
      take();
      return parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const token = take();
    if (token === undefined) fail("the expression ends before it is finished");
    if (token === "(") {
      const value = parseExpression();
      if (take() !== ")") fail("a '(' is never closed");
      return value;
    }
    if (/^\d/.test(token as string)) return Number(token);
    const name = token as string;
    if (name in CONSTANTS) return CONSTANTS[name] as number;
    if (name in FUNCTIONS) {
      if (take() !== "(") fail(`${name} needs its arguments in parentheses`);
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(parseExpression());
        while (peek() === ",") {
          take();
          args.push(parseExpression());
        }
      }
      if (take() !== ")") fail(`the arguments to ${name} are never closed`);
      return (FUNCTIONS[name] as (...a: number[]) => number)(...args);
    }
    return fail(`'${name}' is not a number, an operator, or a function I know`);
  };

  try {
    const value = parseExpression();
    if (position < tokens.length) {
      return { ok: false, expression, reason: `I could not read '${tokens.slice(position).join(" ")}'.` };
    }
    if (!Number.isFinite(value)) {
      // Infinity and NaN are results a model will happily narrate as a number. They are not one.
      return { ok: false, expression, reason: "That does not have a finite numeric answer." };
    }
    return { ok: true, expression, value };
  } catch (error) {
    return { ok: false, expression, reason: `I could not evaluate that: ${(error as Error).message}.` };
  }
};

export type TimeResult =
  | { readonly ok: true; readonly iso: string; readonly formatted: string; readonly timeZone: string; readonly epochMs: number }
  | { readonly ok: false; readonly reason: string };

/**
 * The current time, in a named zone.
 *
 * A model has no clock -- it has a training cutoff, and it will answer "what is today's date" with something
 * plausible and wrong. The zone is a parameter because "today" is a different day depending on where the person
 * asking is, and the caller is often not in UTC.
 *
 * The clock is injected so a test can pin it, which is the convention everywhere else in this runtime.
 */
export const currentTime = (input: { readonly timeZone?: string; readonly now?: () => Date } = {}): TimeResult => {
  const timeZone = input.timeZone ?? "UTC";
  const at = (input.now ?? (() => new Date()))();
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
      // 24-hour, explicitly. The locale default here is "1:34:56 p.m.", and a model that has to re-derive
      // whether that is 01:34 or 13:34 is one that will sometimes get it wrong -- for a value it asked for
      // precisely because it could not work it out itself.
      hourCycle: "h23",
    }).format(at);
    return { ok: true, iso: at.toISOString(), formatted, timeZone, epochMs: at.getTime() };
  } catch {
    // An unknown zone is the caller's mistake and worth naming, not worth guessing UTC for: a wrong timezone
    // produces an answer that is confidently off by hours.
    return { ok: false, reason: `'${timeZone}' is not a time zone I recognise. Use an IANA name like 'Europe/Berlin'.` };
  }
};
