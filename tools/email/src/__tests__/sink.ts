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
  /**
   * How many client connections have closed.
   *
   * Observable so a test can assert the client *released* the socket, which is a guarantee the
   * handshake deadline makes in its own comment — "a half-open handshake holds a socket and a file
   * descriptor" — and which nothing checked: removing both `destroy()` calls broke no test, and the
   * cost is one leaked descriptor per failed handshake, which a real deployment discovers as
   * EMFILE hours later.
   */
  readonly closes: () => number;
  /** Every complete DATA payload the sink received, exactly as transmitted. */
  readonly messages: string[];
  /** Every command line, so a test can assert the envelope rather than only the message. */
  readonly commands: string[];
  readonly close: () => Promise<void>;
};

export const startSink = async (options: SinkOptions = {}): Promise<Sink> => {
  const messages: string[] = [];
  const commands: string[] = [];
  let closes = 0;
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
    /**
     * Set once STARTTLS is answered, after which the sink says **nothing** ever again.
     *
     * This sink cannot speak TLS, and the tests that ask for STARTTLS want it to stall — that is how a
     * real server which advertises STARTTLS and then goes quiet wedges a client with no handshake
     * deadline. Going quiet has to be deliberate, because the alternative is not silence:
     *
     * There was no `STARTTLS` case in the switch below, so it fell through to `default`, which answers
     * `235 Authentication successful`. The client then sends a ClientHello, whose bytes contain `\r\n`,
     * so this loop read the handshake as command lines and answered each one in plaintext — and OpenSSL
     * read *that* as a TLS record: `tls_validate_record_header: wrong version number`.
     *
     * That error races the handshake deadline, and whichever arrives first decides the outcome. It made
     * two tests fail roughly one run in six under load while passing every time in isolation — the exact
     * shape their own comments warn about ("passing here and failing there depending on whether the
     * socket happened to error first"). With the sink silent, the deadline is the only possible outcome.
     */
    let mute = false;
    socket.setEncoding("utf8");
    socket.write("220 sink.test ESMTP ready\r\n");

    const reject = (command: string): boolean => {
      const rule = options.rejectAt;
      if (rule === undefined || !command.toUpperCase().startsWith(rule.command.toUpperCase())) return false;
      socket.write(`${rule.code} ${rule.text ?? "rejected by the sink"}\r\n`);
      return true;
    };

    socket.on("data", (chunk: string) => {
      // Not even buffered once muted: the bytes arriving now are a TLS handshake, and treating them as
      // text is what produced the race described above.
      if (mute) return;
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
          case "STARTTLS":
            /**
             * Answered, then silence. Answering matters: a client that never gets `220` fails at the
             * command rather than at the handshake, which tests something else entirely — whether the
             * upgrade was even attempted is the whole point of the IP-address test.
             */
            socket.write("220 2.0.0 Ready to start TLS\r\n");
            mute = true;
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
    socket.on("close", () => {
      closes += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    messages,
    commands,
    closes: () => closes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
