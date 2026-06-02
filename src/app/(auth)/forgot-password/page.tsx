"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(e.currentTarget);

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    });

    setLoading(false);
    if (res.ok) setSent(true);
    else setError("Erro ao processar solicitação");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-8">
        <h1 className="text-2xl font-bold text-center mb-2 text-gray-900">Esqueci minha senha</h1>

        {sent ? (
          <div className="text-center py-4">
            <div className="text-5xl mb-4">📧</div>
            <p className="font-medium text-gray-900 mb-2">Email enviado!</p>
            <p className="text-sm text-gray-500 mb-6">
              Se este email estiver cadastrado, você receberá as instruções em breve. Verifique também a pasta de spam.
            </p>
            <Link href="/login" className="text-blue-600 text-sm hover:underline">Voltar para o login</Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 text-center mb-6">
              Digite seu email e enviaremos um link para redefinir sua senha.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  name="email"
                  type="email"
                  required
                  autoFocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded-lg">{error}</p>}
              <button
                disabled={loading}
                className="w-full bg-blue-600 text-white rounded-lg py-2 font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                {loading ? "Enviando..." : "Enviar link de redefinição"}
              </button>
            </form>
            <p className="mt-4 text-center text-sm text-gray-600">
              <Link href="/login" className="text-blue-600 hover:underline">Voltar para o login</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
