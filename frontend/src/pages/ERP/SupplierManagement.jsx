import { useState } from "react";
import { erpApi } from "./erpApi.js";

const EMPTY_SUPPLIER = {
  code: "",
  name: "",
  address: "",
  contactName: "",
  email: "",
  phone: "",
  notes: "",
  itemIds: [],
  active: true,
};

export default function SupplierManagement({ suppliers, items, canCreate, canEdit, onChanged }) {
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(EMPTY_SUPPLIER);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const startCreate = () => {
    setEditingId("");
    setDraft(EMPTY_SUPPLIER);
    setError("");
    setNotice("");
    setShowForm(true);
  };

  const startEdit = (supplier) => {
    setEditingId(supplier.id);
    setDraft({
      code: supplier.code,
      name: supplier.name,
      address: supplier.address,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
      notes: supplier.notes,
      itemIds: supplier.itemIds,
      active: supplier.active,
    });
    setError("");
    setNotice("");
    setShowForm(true);
  };

  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const toggleItem = (itemId) => setDraft((current) => ({
    ...current,
    itemIds: current.itemIds.includes(itemId)
      ? current.itemIds.filter((id) => id !== itemId)
      : [...current.itemIds, itemId],
  }));

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editingId) await erpApi.updateSupplier(editingId, draft);
      else await erpApi.createSupplier(draft);
      await onChanged();
      setShowForm(false);
      setNotice(`Supplier ${draft.code} was ${editingId ? "updated" : "registered"}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="stats-grid compact-stats">
      <article className="stat-card"><div className="stat-label">Registered suppliers</div><div className="stat-value">{suppliers.length}</div><div className="stat-note">Supplier accounts on file</div></article>
      <article className="stat-card tone-blue"><div className="stat-label">Active suppliers</div><div className="stat-value">{suppliers.filter((supplier) => supplier.active).length}</div><div className="stat-note">Available for new purchase orders</div></article>
      <article className="stat-card tone-purple"><div className="stat-label">Expected item links</div><div className="stat-value">{suppliers.reduce((total, supplier) => total + supplier.itemIds.length, 0)}</div><div className="stat-note">Supplier-to-inventory associations</div></article>
    </div>

    <section className="panel">
      <div className="panel-heading">
        <div><h2>Supplier accounts</h2><p>Maintain supplier codes, contact details, account status, and expected inventory items.</p></div>
        {canCreate && <button className="button button-primary" type="button" onClick={startCreate}>＋ Register supplier</button>}
      </div>
      {notice && <div className="alert success supplier-notice" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
      {showForm && <form className="form-card supplier-form" onSubmit={save}>
        <div className="form-title"><strong>{editingId ? "Edit supplier account" : "Register supplier account"}</strong><span>Supplier code must be unique. Deactivated suppliers remain on existing purchase history.</span></div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="form-grid form-grid-three">
          <label className="field"><span>Supplier code</span><input required maxLength="40" value={draft.code} onChange={(event) => updateDraft("code", event.target.value)} placeholder="e.g. SUP-001" /></label>
          <label className="field"><span>Supplier name</span><input required maxLength="120" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder="Registered supplier name" /></label>
          <label className="field"><span>Contact person</span><input maxLength="100" value={draft.contactName} onChange={(event) => updateDraft("contactName", event.target.value)} placeholder="Name of contact" /></label>
          <label className="field"><span>Email address</span><input type="email" maxLength="254" value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} placeholder="orders@supplier.example" /></label>
          <label className="field"><span>Telephone</span><input type="tel" maxLength="40" value={draft.phone} onChange={(event) => updateDraft("phone", event.target.value)} placeholder="Supplier phone number" /></label>
          <label className="field supplier-address"><span>Address</span><textarea rows="3" maxLength="1000" value={draft.address} onChange={(event) => updateDraft("address", event.target.value)} placeholder="Street address, city, region, postal code" /></label>
          <label className="field supplier-address"><span>Account notes</span><textarea rows="3" maxLength="2000" value={draft.notes} onChange={(event) => updateDraft("notes", event.target.value)} placeholder="Payment terms, delivery details, or other account notes" /></label>
        </div>
        <div className="supplier-catalog">
          <div className="field-section-title">Inventory items expected from this supplier <span>{draft.itemIds.length} selected</span></div>
          {items.length ? <div className="supplier-item-picker">{items.map((item) => <label className="supplier-item-option" key={item.id}>
            <input type="checkbox" checked={draft.itemIds.includes(item.id)} onChange={() => toggleItem(item.id)} />
            <span><strong>{item.sku}</strong>{item.name}<small>{item.unit}</small></span>
          </label>)}</div> : <div className="inline-notice">There are no active inventory items to link to this supplier.</div>}
        </div>
        {editingId && <label className="supplier-active-toggle"><input type="checkbox" checked={draft.active} onChange={(event) => updateDraft("active", event.target.checked)} /> Supplier account is active and may be selected on new purchase orders</label>}
        <div className="form-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => setShowForm(false)}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy || (editingId ? !canEdit : !canCreate)}>{busy ? "Saving…" : editingId ? "Save supplier" : "Register supplier"}</button>
        </div>
      </form>}
      {suppliers.length ? <div className="table-scroll"><table className="supplier-table">
        <thead><tr><th>Supplier</th><th>Contact details</th><th>Address / notes</th><th>Expected inventory items</th><th>Status</th>{canEdit && <th>Action</th>}</tr></thead>
        <tbody>{suppliers.map((supplier) => {
          const expectedItems = supplier.itemIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
          return <tr key={supplier.id}>
            <td><strong className="primary-cell">{supplier.name}</strong><span className="secondary-cell">Code: {supplier.code}</span></td>
            <td>{supplier.contactName && <span className="supplier-detail-line">{supplier.contactName}</span>}{supplier.email && <span className="supplier-detail-line">{supplier.email}</span>}{supplier.phone && <span className="supplier-detail-line">{supplier.phone}</span>}{!supplier.contactName && !supplier.email && !supplier.phone && <span className="muted-text">No contact details</span>}</td>
            <td className="supplier-address-cell">{supplier.address || <span className="muted-text">No address</span>}{supplier.notes && <span className="supplier-notes">{supplier.notes}</span>}</td>
            <td>{expectedItems.length ? <div className="supplier-item-tags">{expectedItems.map((item) => <span key={item.id}>{item.sku}</span>)}</div> : <span className="muted-text">Not specified</span>}</td>
            <td><span className={`status-pill ${supplier.active ? "status-posted" : "status-low"}`}>{supplier.active ? "Active" : "Inactive"}</span></td>
            {canEdit && <td><button className="button button-secondary button-small" type="button" onClick={() => startEdit(supplier)}>Edit</button></td>}
          </tr>;
        })}</tbody>
      </table></div> : <div className="empty-state"><strong>No supplier accounts registered</strong><p>Register suppliers here to use them on purchase orders and maintain their expected item catalog.</p>{canCreate && <button className="button button-primary button-small" type="button" onClick={startCreate}>Register first supplier</button>}</div>}
    </section>
  </>;
}
