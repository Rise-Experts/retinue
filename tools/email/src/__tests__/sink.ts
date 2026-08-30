/**
 * An in-process SMTP sink — REQ-056 (#240), task #241, AC-7.
 *
 * The AC asks for both providers to be exercised against a local capture, and this is the SMTP half. It speaks
 * enough of the protocol to be a real conversation — greeting, EHLO with a capability list, AUTH, MAIL, RCPT,
 * DATA, dot-terminated body, QUIT — because the point is to test the *client* rather than a mock of it.
 *
 * It can also be told to reject at a chosen command with a chosen code, which is what AC-6 needs: the defect
 * worth guarding against is a rejection reported as a send, and the only way to know it is not happening is to
 * make a server reject and watch what the tool says.
 */

import { createServer, type Server, type Socket } from "node:net";

export type SinkOptions = {
  /** Reject at this command with this code — `{ command: "RCPT", code: 550 }`. */
  readonly rejectAt?: { readonly command: string; readonly code: number; readonly text?: string };
  /** Advertised in EHLO. Omit STARTTLS to test the refusal to send in the clear. */
  readonly capabilities?: readonly string[];
  /** What the server says to the terminating dot. */
  readonly acceptText?: string;
};

export type Sink = {
  readonly port: number;
  /** Every complete DATA payload the sink received, exactly as transmitted. */
  readonly messages: string[];
  /** Every command line, so a test can assert the envelope rather than only the message. */
  readonly commands: string[];
  readonly close: () => Promise<void>;
};

export const startSink = async (options: SinkOptions = {}): Promise<Sink> => {
  const messages: string[] = [];
  const commands: string[] = [];
  /**
   * No `STARTTLS` by default, because this sink cannot do TLS.
   *
   * Advertising a capability it does not have would make every test fail at the upgrade — and would be the
   * sink lying, which is a strange foundation for tests about a client that must not lie. A test that wants
   * the STARTTLS path asks for it explicitly.
   */
  const capabilities = options.capabilities ?? ["AUTH PLAIN LOGIN", "8BITMIME"];

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let body = "";
    socket.setEncoding("utf8");
    socket.write("220 sink.test ESMTP ready\r\n");

    const reject = (command: string): boolean => {
      const rule = options.rejectAt;
      if (rule === undefined || !command.toUpperCase().startsWith(rule.command.toUpperCase())) return false;
      socket.write(`${rule.code} ${rule.text ?? "rejected by the sink"}\r\n`);
      return true;
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            // Un-stuff, so a test comparing against the composed message sees what was meant rather than what
            // the wire carried.
            messages.push(body.replace(/^\.\./gm, "."));
            body = "";
            if (!reject("DATA-END")) socket.write(`250 ${options.acceptText ?? "2.0.0 Ok: queued as ABC123"}\r\n`);
            continue;
          }
          body += `${line}\r\n`;
          continue;
        }

        commands.push(line);
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        if (reject(verb)) continue;

        switch (verb) {
          case "EHLO":
          case "HELO": {
            // Multi-line: every line but the last has a hyphen. A client that reads only the first line never
            // sees the capabilities, which is the bug this shape exists to catch.
            const lines = ["250-sink.test", ...capabilities.map((cap) => `250-${cap}`)];
            lines[lines.length - 1] = `250 ${capabilities[capabilities.length - 1] ?? "OK"}`;
            socket.write(`${lines.join("\r\n")}\r\n`);
            break;
          }
          case "AUTH":
            socket.write(line.toUpperCase().includes("PLAIN ") ? "235 2.7.0 Authentication successful\r\n" : "334 VXNlcm5hbWU6\r\n");
            break;
          case "MAIL":
          case "RCPT":
            socket.write("250 2.1.0 Ok\r\n");
            break;
          case "DATA":
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            break;
          case "QUIT":
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
            break;
          default:
            // A base64 continuation during AUTH LOGIN, or anything else.
            socket.write("235 2.7.0 Authentication successful\r\n");
        }
      }
    });
    socket.on("error", () => {
      // A client that hangs up mid-conversation is normal in these tests.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    messages,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
