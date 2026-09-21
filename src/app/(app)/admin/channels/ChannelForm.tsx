"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createChannelAction, type ChannelInput } from "./actions";

const TYPES: { value: string; label: string }[] = [
  { value: "WEB", label: "Portal" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "EMAIL", label: "E-mail" },
  { value: "PUBLIC_FORM", label: "Formulário público" },
  { value: "API", label: "API" },
];

const PROVIDERS: { value: string; label: string }[] = [
  { value: "WHATSAPP_CLOUD", label: "WhatsApp Cloud (oficial)" },
  { value: "WHATSAPP_MOCK", label: "WhatsApp Mock (dev)" },
  { value: "EMAIL_RESEND", label: "E-mail (Resend)" },
  { value: "EMAIL_IMAP", label: "E-mail (IMAP)" },
  { value: "INTERNAL", label: "Interno" },
];

export default function ChannelForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const f = e.currentTarget;
    const fd = new FormData(f);
    const input: ChannelInput = {
      label: String(fd.get("label") ?? ""),
      type: String(fd.get("type") ?? "WEB") as ChannelInput["type"],
      provider: String(fd.get("provider") ?? "INTERNAL") as ChannelInput["provider"],
      externalId: String(fd.get("externalId") ?? "") || undefined,
      secretRef: String(fd.get("secretRef") ?? ""),
      active: fd.get("active") === "on",
    };
    startTransition(async () => {
      const res = await createChannelAction(input);
      if (!res.ok) {
        setError(res.error);
      } else {
        setSuccess("Canal registrado com sucesso!");
        f.reset();
        router.refresh();
      }
    });
  }

  const inputCls =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Rótulo *</label>
        <input name="label" required maxLength={120} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tipo *</label>
          <select name="type" className={inputCls} defaultValue="WHATSAPP">
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Provedor *</label>
          <select name="provider" className={inputCls} defaultValue="WHATSAPP_CLOUD">
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">ID externo</label>
        <input name="externalId" maxLength={200} placeholder="ex.: phone_number_id" className={inputCls} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Referência do segredo (secretRef) *</label>
        <input name="secretRef" required maxLength={200} placeholder="ex.: env:WHATSAPP_TOKEN_ACME" className={inputCls} />
        <p className="text-xs text-gray-400 mt-1">
          Informe uma REFERÊNCIA (variável de ambiente / secret manager). Nunca cole o valor do segredo aqui.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input name="active" type="checkbox" defaultChecked className="rounded border-gray-300" />
        Ativo
      </label>
      {error && <p className="text-red-500 text-xs bg-red-50 p-2 rounded-lg">{error}</p>}
      {success && <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg">{success}</p>}
      <button
        disabled={pending}
        className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
      >
        {pending ? "Salvando..." : "Registrar canal"}
      </button>
    </form>
  );
}
