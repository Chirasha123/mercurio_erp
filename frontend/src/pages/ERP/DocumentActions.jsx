import { useState } from "react";
import { erpApi } from "./erpApi.js";

const DOCUMENT_TITLES = {
  "purchase-order": "purchase order",
  "supplier-invoice": "supplier invoice",
  "sales-invoice": "sales invoice",
};

export default function DocumentActions({ type, id, reference, recipient = "", canEmail = true, onSent }) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailError, setEmailError] = useState("");
  const [sending, setSending] = useState(false);
  const title = DOCUMENT_TITLES[type];

  const openEmailForm = () => {
    setEmailTo(recipient);
    setEmailError("");
    setEmailOpen(true);
  };

  const send = async (event) => {
    event.preventDefault();
    setSending(true);
    setEmailError("");
    try {
      await erpApi.emailDocument(type, id, emailTo);
      setEmailOpen(false);
      onSent?.(`${title} ${reference} was emailed to ${emailTo}.`);
    } catch (error) {
      setEmailError(error.message);
    } finally {
      setSending(false);
    }
  };

  return <>
    <div className="document-row-actions">
      <a className="button button-secondary button-small" href={`/api/documents/${type}/${id}/pdf`} target="_blank" rel="noreferrer">PDF / Print</a>
      {canEmail && <button className="button button-secondary button-small" type="button" onClick={openEmailForm}>Email</button>}
    </div>
    {emailOpen && <div className="document-email-overlay">
      <section className="document-email-dialog" role="dialog" aria-modal="true" aria-labelledby={`email-title-${id}`}>
        <div className="panel-heading">
          <div><h2 id={`email-title-${id}`}>Email {title}</h2><p>{reference} will be sent as a PDF attachment.</p></div>
          <button className="icon-button" type="button" aria-label="Close email form" onClick={() => setEmailOpen(false)}>×</button>
        </div>
        {emailError && <div className="alert error" role="alert">{emailError}</div>}
        <form onSubmit={send}>
          <label className="field"><span>Recipient email</span><input type="email" autoComplete="email" maxLength="254" required value={emailTo} onChange={(event) => setEmailTo(event.target.value)} /></label>
          <div className="form-actions">
            <button className="button button-secondary" type="button" disabled={sending} onClick={() => setEmailOpen(false)}>Cancel</button>
            <button className="button button-primary" type="submit" disabled={sending}>{sending ? "Sending…" : "Send PDF"}</button>
          </div>
        </form>
      </section>
    </div>}
  </>;
}
