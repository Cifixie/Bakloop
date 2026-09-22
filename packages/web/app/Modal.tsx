"use client";

import { useEffect, useRef } from "react";

export function Modal({ open, onClose, children }: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "48px 16px",
        overflowY: "auto",
      }}
    >
      <div
        ref={panelRef}
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          width: "100%",
          maxWidth: 680,
          maxHeight: "calc(100vh - 96px)",
          overflowY: "auto",
        }}
      >
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "12px 16px",
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#6b7280",
              lineHeight: 1,
              padding: "2px 6px",
              borderRadius: 4,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div style={{ padding: "0 24px 24px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
