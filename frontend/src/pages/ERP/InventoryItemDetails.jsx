import { useEffect, useState } from "react";
import { erpApi } from "./erpApi.js";

const EMPTY_DETAILS = { supplierCode: "", notes: "", hasImage: false, imageFilename: "", updatedAt: null };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the selected picture."));
        return;
      }
      const base64 = reader.result.split(",")[1];
      if (!base64) {
        reject(new Error("The selected picture is empty."));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Could not read the selected picture."));
    reader.readAsDataURL(file);
  });
}

export default function InventoryItemDetails({ item, canEdit, onClose, onSaved }) {
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [image, setImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [removeImage, setRemoveImage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    erpApi.getItemDetails(item.id)
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [item.id]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const chooseImage = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setImage(null);
    setPreviewUrl("");
    setError("");
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError("Choose a JPEG, PNG, or WebP picture.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("The picture must be 2 MB or smaller.");
      event.target.value = "";
      return;
    }
    setImage(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveImage(false);
  };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = {
        supplierCode: details.supplierCode,
        notes: details.notes,
        removeImage,
      };
      if (image) {
        payload.imageData = await readImage(image);
        payload.imageMimeType = image.type;
        payload.imageFilename = image.name;
      }
      const updated = await erpApi.saveItemDetails(item.id, payload);
      setDetails(updated);
      setImage(null);
      setPreviewUrl("");
      setRemoveImage(false);
      onSaved(`Details for ${item.sku} were saved.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const imageUrl = details.hasImage
    ? `/api/items/${item.id}/image?v=${encodeURIComponent(details.updatedAt ?? "")}`
    : "";
  const displayedImage = previewUrl || (!removeImage ? imageUrl : "");

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="item-report-modal inventory-details-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-details-title">
      <div className="report-modal-header">
        <div>
          <div className="eyebrow">INVENTORY ITEM DETAILS</div>
          <h2 id="inventory-details-title">{item.sku} · {item.name}</h2>
          <p>Supplier reference, handling notes, and item picture.</p>
        </div>
        <button className="icon-button report-close" type="button" aria-label="Close item details" disabled={busy} onClick={onClose}>×</button>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {loading ? <div className="loading-state">Loading item details…</div> : <form onSubmit={save}>
        <div className="inventory-details-layout">
          <div className="inventory-image-column">
            <div className="inventory-image-frame">
              {displayedImage
                ? <img src={displayedImage} alt={`Product ${item.name}`} />
                : <div className="inventory-image-empty"><span aria-hidden="true">▧</span><strong>No picture added</strong></div>}
            </div>
            {canEdit && <>
              <label className="button button-secondary inventory-image-picker">
                Choose picture
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseImage} />
              </label>
              <small>JPEG, PNG, or WebP · maximum 2 MB</small>
              {details.hasImage && <button className="text-button inventory-remove-image" type="button" onClick={() => {
                setImage(null);
                setPreviewUrl("");
                setRemoveImage(true);
              }}>Remove saved picture</button>}
            </>}
            {!canEdit && details.imageFilename && <small>{details.imageFilename}</small>}
          </div>
          <div className="inventory-details-fields">
            <label className="field">
              <span>Supplier item code</span>
              <input maxLength="100" value={details.supplierCode} disabled={!canEdit} placeholder="Supplier's code for this item" onChange={(event) => setDetails((current) => ({ ...current, supplierCode: event.target.value }))} />
            </label>
            <label className="field">
              <span>Item notes</span>
              <textarea rows="7" maxLength="4000" disabled={!canEdit} placeholder="Add specifications, storage instructions, or other useful notes." value={details.notes} onChange={(event) => setDetails((current) => ({ ...current, notes: event.target.value }))} />
              <small>{details.notes.length}/4000 characters</small>
            </label>
          </div>
        </div>
        <div className="form-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>Close</button>
          {canEdit && <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save item details"}</button>}
        </div>
      </form>}
    </section>
  </div>;
}
