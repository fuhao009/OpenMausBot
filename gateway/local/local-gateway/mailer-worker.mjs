// The browser-facing pieces the local gateway runs inside the Worker sandbox.
//
// `MAILER_SOURCE` is a second Worker in the same Miniflare instance. Its
// `EMAIL` entrypoint is the binding the account Worker calls (`env.EMAIL.send`),
// exactly like Cloudflare Email Sending. It has no SMTP settings: it forwards
// the message object to a Node-side fetch service binding (`MAIL`), which is
// where the operator's SMTP credentials live and where the only network
// submission happens.
//
// Keeping the adapter in the Worker means sign-in mail is produced by the
// Worker's own code path (the real OTP, subject, and body), never re-created
// here, and no SMTP secret is exposed to Worker code or vars.

export const MAILER_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class EmailSender extends WorkerEntrypoint {
  async send(message) {
    if (typeof this.env.MAIL?.fetch !== "function") throw new Error("mail_transport_unavailable");
    const response = await this.env.MAIL.fetch("http://mail.invalid/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error("mail_delivery_failed");
    return await response.json();
  }
}

export default { fetch() { return new Response("mail transport", { status: 404 }); } };
`;
