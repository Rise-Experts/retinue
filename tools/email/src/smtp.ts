/**
 * A minimal SMTP client — REQ-056 (#240), task #241, AC-6 and AC-7.
 *
 * Written rather than depended on, for the same reason `tools-scrape` builds its own fetch: the thing that
 * matters here is a behaviour no library guarantees on our behalf, and one this package must be able to prove.
 *
 * ## The one defect that would cause real harm
 *
 * AC-6 names it: **a rejected send reported as a success.** Every other bug in this package costs somebody a
 * confusing error. This one costs them the mail — the caller stops trying, nobody is told, and the message
 * simply never arrives. It is also easy to write by accident, because SMTP replies to almost everything with
 * a number and a naive client checks only that the socket did not error.
 *
 * So every command's reply code is read and checked. A `250` after `DATA`'s terminating dot is the *only*
 * thing that means sent; anything else is a failure, and the failure says which command was rejected.
 *
 * ## 4xx and 5xx are not the same answer
 *
 * SMTP separates them precisely, and clients routinely conflate them:
 *
 * - **4xx is transient.** "Mailbox busy", "greylisted", "try again later". Retrying is the *correct* response
 *   and greylisting in particular is designed around the assumption that a real sender will.
 * - **5xx is permanent.** "No such user", "message rejected as spam", "relay denied". Retrying is useless and,
 *   against a reputation-scoring receiver, actively harmful.
 *
 * Reporting a 5xx as retryable makes an agent hammer a server that has already refused. Reporting a 4xx as
 * permanent throws away a message that would have been delivered on the second attempt.
 *
 * ## What this deliberately does not do
 *
 * No connection pooling, no pipelining, no DSN, no 8BITMIME negotiation, no XOAUTH2. One message per
 * connection. This is a transactional-send path for a deployment's own mail, not a mail server, and every one
 * of those features is a reason to reach for a real library instead.
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export type SmtpReply = { readonly code: number; readonly lines: readonly string[] };

export class SmtpError extends Error {
  readonly code: number;
  readonly command: string;
  /** 4xx. The distinction the whole class exists for. */
  readonly retryable: boolean;

  constructor(input: { code: number; command: string; message: string }) {
    super(input.message);
    this.name = "SmtpError";
    this.code = input.code;
    this.command = input.command;
    // 4xx transient, 5xx permanent. A code outside both is treated as permanent: an unrecognised reply is not
    // a reason to keep sending.
    this.retryable = input.code >= 400 && input.code < 500;
  }
}

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte — port 465. Otherwise STARTTLS is used unless `requireTls` is false. */
  readonly secure?: boolean;
  /**
   * Refuse to send if the connection cannot be encrypted. Default **true**.
   *
   * Sending credentials and a message in the clear because a server did not advertise STARTTLS is not a
   * fallback, it is a downgrade — and one an attacker on the path can force by stripping the advertisement.
   * Turning this off is for a sink on localhost, which is what the tests use.
   */
  readonly requireTls?: boolean;
  readonly timeoutMs?: number;
  /** Sent in EHLO. A name, not a hostname to be resolved. */
  readonly clientName?: string;
};

type Connection = {
  readonly send: (command: string, expect: readonly number[]) => Promise<SmtpReply>;
  readonly sendRaw: (payload: string) => void;
  readonly upgrade: () => Promise<void>;
  readonly close: () => void;
  readonly capabilities: () => readonly string[];
  readonly setCapabilities: (lines: readonly string[]) => void;
};

/**
 * Reads SMTP replies off a socket.
 *
 * A reply is one or more lines; every line but the last has a `-` after the code. Reading only the first line
 * is the classic bug — the EHLO response is multi-line and its later lines are the capability list, so a
 * client that stops at the first has no idea whether STARTTLS is available.
 */
const createConnection = (socket: Socket | TLSSocket, timeoutMs: number, host: string): Connection => {
  let buffer = "";
  let capabilities: readonly string[] = [];
  let current: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined;
  let active: Socket | TLSSocket = socket;

  const attach = (target: Socket | TLSSocket) => {
    target.setEncoding("utf8");
    target.on("data", (chunk: string) => {
      buffer += chunk;
      // A complete reply ends with a line whose code is followed by a space rather than a hyphen.
      const match = /(^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buffer);
      if (match === null || current === undefined) return;
      const lines = buffer.split("\r\n").filter((line) => line !== "");
      const code = Number.parseInt(match[2] as string, 10);
      buffer = "";
      const waiting = current;
      current = undefined;
      waiting.resolve({ code, lines });
    });
    target.on("error", (error: Error) => {
      const waiting = current;
      current = undefined;
      waiting?.reject(error);
    });
    target.on("close", () => {
      const waiting = current;
      current = undefined;
      waiting?.reject(new Error("The SMTP server closed the connection."));
    });
  };
  attach(active);

  const await_ = (command: string, expect: readonly number[]): Promise<SmtpReply> =>
    new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        current = undefined;
        reject(new Error(`No SMTP reply to ${command} within ${timeoutMs}ms.`));
      }, timeoutMs);
      current = {
        resolve: (reply) => {
          clearTimeout(timer);
          if (expect.length > 0 && !expect.includes(Math.floor(reply.code / 100))) {
            reject(
              new SmtpError({
                code: reply.code,
                command,
                message: `${host} rejected ${command}: ${reply.lines.join(" ")}`,
              }),
            );
            return;
          }
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

  return {
    capabilities: () => capabilities,
    setCapabilities: (lines) => {
      capabilities = lines.map((line) => line.slice(4).trim().toUpperCase());
    },
    async send(command, expect) {
      const promise = await_(command === "" ? "the greeting" : command.split(" ")[0] ?? command, expect);
      if (command !== "") active.write(`${command}\r\n`);
      return promise;
    },
    sendRaw(payload) {
      active.write(payload);
    },
    async upgrade() {
      const plain = active as Socket;
      await new Promise<void>((resolve, reject) => {
        const secured = tlsConnect({ socket: plain, servername: host }, () => resolve());
        secured.on("error", reject);
        active = secured;
        attach(secured);
      });
    },
    close() {
      active.destroy();
    },
  };
};

export type SmtpSendInput = {
  /** The envelope sender. Not necessarily the `From` header, and the one the bounce goes to. */
  readonly from: string;
  readonly to: readonly string[];
  /** The composed RFC 5322 message. `Bcc` must already be stripped — see `stripBcc`. */
  readonly raw: string;
  readonly username?: string;
  readonly password?: string;
};

export type SmtpSendResult = {
  /** The server's reply to the terminating dot. The only thing that means accepted. */
  readonly reply: string;
  readonly code: number;
  /** Parsed out of the reply when the server states one, which many do. */
  readonly messageId?: string;
  readonly recipientsAccepted: readonly string[];
};

/**
 * Dot-stuffing — a line of a single `.` ends the DATA phase.
 *
 * A message body containing such a line would otherwise terminate the message early, and everything after it
 * is interpreted as SMTP commands. That is not only a truncated mail: it is a command-injection primitive
 * reachable by anyone who can get text into a message body.
 */
export const dotStuff = (raw: string): string =>
  raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n").replace(/^\./gm, "..");

export type SmtpDialer = (config: SmtpConfig) => Promise<Socket | TLSSocket>;

const defaultDialer: SmtpDialer = (config) =>
  new Promise((resolve, reject) => {
    const socket = config.secure === true
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
      : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.on("error", reject);
  });

/** Sends one message over one connection, checking every reply. */
export const smtpSend = async (
  config: SmtpConfig,
  input: SmtpSendInput,
  dialer: SmtpDialer = defaultDialer,
): Promise<SmtpSendResult> => {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const socket = await dialer(config);
  const connection = createConnection(socket, timeoutMs, config.host);

  try {
    await connection.send("", [2]); // the greeting
    const client = config.clientName ?? "retinue";
    let ehlo = await connection.send(`EHLO ${client}`, [2]);
    connection.setCapabilities(ehlo.lines);

    if (config.secure !== true) {
      const offersStartTls = connection.capabilities().some((line) => line.startsWith("STARTTLS"));
      if (offersStartTls) {
        await connection.send("STARTTLS", [2]);
        await connection.upgrade();
        // EHLO again: capabilities before and after TLS differ, and AUTH is commonly advertised only after.
        ehlo = await connection.send(`EHLO ${client}`, [2]);
        connection.setCapabilities(ehlo.lines);
      } else if (config.requireTls !== false) {
        throw new SmtpError({
          code: 554,
          command: "STARTTLS",
          message:
            `${config.host} does not offer STARTTLS, so this connection cannot be encrypted. Refusing to send ` +
            "credentials and a message in the clear. Set requireTls false only for a local sink.",
        });
      }
    }

    if (input.username !== undefined && input.password !== undefined) {
      const supported = connection.capabilities().find((line) => line.startsWith("AUTH"));
      const mechanisms = (supported ?? "").toUpperCase();
      if (mechanisms.includes("PLAIN") || supported === undefined) {
        const token = Buffer.from(`\0${input.username}\0${input.password}`, "utf8").toString("base64");
        await connection.send(`AUTH PLAIN ${token}`, [2]);
      } else if (mechanisms.includes("LOGIN")) {
        await connection.send("AUTH LOGIN", [3]);
        await connection.send(Buffer.from(input.username, "utf8").toString("base64"), [3]);
        await connection.send(Buffer.from(input.password, "utf8").toString("base64"), [2]);
      } else {
        throw new SmtpError({
          code: 504,
          command: "AUTH",
          message: `${config.host} offers no authentication mechanism this client supports (${mechanisms}).`,
        });
      }
    }

    await connection.send(`MAIL FROM:<${input.from}>`, [2]);
    const accepted: string[] = [];
    for (const recipient of input.to) {
      // Per recipient, and each reply checked. A server that accepts three of four recipients has partially
      // failed, and reporting "sent" would be true of three people and false of the fourth.
      await connection.send(`RCPT TO:<${recipient}>`, [2]);
      accepted.push(recipient);
    }

    await connection.send("DATA", [3]);
    connection.sendRaw(`${dotStuff(input.raw)}\r\n.\r\n`);
    /**
     * The reply to the dot is the only thing that means sent.
     *
     * Everything before it says the server was willing to *consider* the message. This is the check whose
     * absence would let a rejection be reported as a success.
     */
    const done = await connection.send("", [2]);

    try {
      await connection.send("QUIT", []);
    } catch {
      // A server that drops the connection at QUIT has still accepted the message. Failing here would turn a
      // successful send into a reported failure, which is the same class of lie in the other direction.
    }

    const reply = done.lines.join(" ");
    const messageId = /queued as ([^\s>]+)/i.exec(reply)?.[1] ?? /id=([^\s>;]+)/i.exec(reply)?.[1];
    return {
      reply,
      code: done.code,
      ...(messageId === undefined ? {} : { messageId }),
      recipientsAccepted: accepted,
    };
  } finally {
    connection.close();
  }
};
