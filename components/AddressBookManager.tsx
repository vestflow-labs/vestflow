"use client";

import { useState, useMemo } from "react";
import { useAddressBook } from "@/hooks/useAddressBook";

interface AddressBookManagerProps {
  onClose: () => void;
}

/**
 * Modal for managing address book entries (add, edit, delete).
 * Users can save Stellar addresses with friendly nicknames for quick reference.
 */
export function AddressBookManager({ onClose }: AddressBookManagerProps) {
  const { addressBook, setLabel, removeLabel } = useAddressBook();
  const [formAddress, setFormAddress] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [error, setError] = useState("");

  const isValidStellarAddress = (addr: string): boolean => {
    return addr.length === 56 && addr.startsWith("G");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedAddr = formAddress.trim();
    const trimmedLabel = formLabel.trim();

    if (!trimmedAddr || !trimmedLabel) {
      setError("Address and nickname are required");
      return;
    }

    if (!isValidStellarAddress(trimmedAddr)) {
      setError("Invalid Stellar address (must start with G and be 56 characters)");
      return;
    }

    if (editingAddress && editingAddress !== trimmedAddr && trimmedAddr in addressBook) {
      setError("This address is already in your address book");
      return;
    }

    // If editing a different address, remove the old one
    if (editingAddress && editingAddress !== trimmedAddr) {
      removeLabel(editingAddress);
    }

    setLabel(trimmedAddr, trimmedLabel);
    setFormAddress("");
    setFormLabel("");
    setEditingAddress(null);
  };

  const handleEdit = (address: string, label: string) => {
    setFormAddress(address);
    setFormLabel(label);
    setEditingAddress(address);
    setError("");
  };

  const handleDelete = (address: string) => {
    if (confirm(`Delete "${addressBook[address]}" from your address book?`)) {
      removeLabel(address);
    }
  };

  const handleCancel = () => {
    setFormAddress("");
    setFormLabel("");
    setEditingAddress(null);
    setError("");
  };

  const entries = useMemo(() => {
    return Object.entries(addressBook).sort((a, b) => a[1].localeCompare(b[1]));
  }, [addressBook]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
           style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)" }}>
        <div className="sticky top-0 border-b px-6 py-4 flex items-center justify-between"
             style={{ borderColor: "var(--border-subtle)", background: "var(--card-bg)" }}>
          <h2 className="text-xl font-semibold" style={{ color: "var(--foreground)" }}>Address Book</h2>
          <button
            onClick={onClose}
            className="transition-colors"
            style={{ color: "var(--muted-light)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--foreground)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted-light)")}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Add/Edit Form */}
          <div className="card p-4" style={{ background: "var(--input-bg)", border: "1px solid var(--input-border)" }}>
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--foreground)" }}>
              {editingAddress ? "Edit Entry" : "Add New Entry"}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted)" }}>
                  Stellar Address
                </label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={(e) => {
                    setFormAddress(e.target.value.toUpperCase());
                    setError("");
                  }}
                  placeholder="G..."
                  className="input"
                  style={{
                    background: "var(--input-bg)",
                    color: "var(--foreground)",
                    borderColor: "var(--input-border)",
                  }}
                  disabled={!!editingAddress}
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--muted)" }}>
                  Nickname
                </label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={(e) => {
                    setFormLabel(e.target.value);
                    setError("");
                  }}
                  placeholder="e.g. My Savings Wallet"
                  className="input"
                  style={{
                    background: "var(--input-bg)",
                    color: "var(--foreground)",
                    borderColor: "var(--input-border)",
                  }}
                />
              </div>

              {error && (
                <div className="px-3 py-2 rounded text-sm" 
                     style={{ background: "var(--accent-error)", color: "white", opacity: 0.15 }}>
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-colors text-white"
                  style={{ background: "var(--accent-primary)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >
                  {editingAddress ? "Update" : "Add"}
                </button>
                {editingAddress && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-4 py-2 border rounded-lg font-medium text-sm transition-colors"
                    style={{ borderColor: "var(--border-default)", color: "var(--foreground)" }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Entries List */}
          {entries.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--foreground)" }}>
                Saved Addresses ({entries.length})
              </h3>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {entries.map(([address, label]) => (
                  <div
                    key={address}
                    className="flex items-center justify-between p-3 rounded-lg transition-colors"
                    style={{
                      background: "var(--input-bg)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--foreground)" }}>{label}</p>
                      <p className="text-xs font-mono truncate" style={{ color: "var(--muted)" }}>{address}</p>
                    </div>
                    <div className="flex gap-2 shrink-0 ml-3">
                      <button
                        onClick={() => handleEdit(address, label)}
                        className="px-2.5 py-1 text-xs rounded border transition-colors"
                        style={{
                          borderColor: "var(--border-default)",
                          color: "var(--foreground)",
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(address)}
                        className="px-2.5 py-1 text-xs rounded border transition-colors"
                        style={{
                          borderColor: "var(--accent-error)",
                          color: "var(--accent-error)",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-sm" style={{ color: "var(--muted)" }}>No saved addresses yet</p>
              <p className="text-xs mt-1" style={{ color: "var(--muted-light)" }}>
                Add your first address above to get started
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
