"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [valid, setValid] = useState<boolean | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) { setValid(false); setTokenError("Link inválido"); return; }
    fetch(`/api/auth/reset-password?token=${token}`)
      .then((r) => r.json())
      .then((d) => { setValid(d.valid); if (!d.valid) setTokenError(d.error); });
  }, [token]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const form = new FormData(e.currentTarget);
    const password = form.get("password") as string;
    const confirm = form.get("confirm") as string;

    if (password !== confirm) { setError("As senhas não coincidem"); return; }
    setLoading(true);

    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

    const data = await res.json();
    setLoading(false);
    if (!res.ok) setError(data.error);
    else setSuccess(true);
  }

  if (valid === null) return <p className="text-center text-gray-500 py-8">Verificando link...</p>;

  if (!valid) return (
    <div className="text-center py-4">
      <div className="text-5xl mb-4">❌</div>
      <p className="font-medium text-gray-900 mb-2">{tokenError}</p>
      <Link href="/forgot-password" className="text-blue-600 text-sm hover:underline">Solicitar novo link</Link>
    </div>
  );

  if (success) return (
    <div className="text-center py-4">
      <div className="text-5xl mb-4">✅</div>
      <p className="font-medium text-gray-900 mb-2">Senha redefinida!</p>
      <p className="text-sm text-gray-500 mb-6">Você já pode fazer login com sua nova senha.</p>
      <button onClick={() => router.push("/login")} className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700">
        Ir para o login
      </button>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Nova senha</label>
        <input name="password" type="password" required minLength={6} placeholder="Mínimo 6 caracteres"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar senha</label>
        <input name="confirm" type="password" required placeholder="Repita a nova senha"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>
      {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded-lg">{error}</p>}
      <button disabled={loading} className="w-full bg-blue-600 text-white rounded-lg py-2 font-medium hover:bg-blue-700 disabled:opacity-60">
        {loading ? "Salvando..." : "Redefinir senha"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow p-8">
        <h1 className="text-2xl font-bold text-center mb-6 text-gray-900">Nova senha</h1>
        <Suspense fallback={<p className="text-center text-gray-500">Carregando...</p>}>
          <ResetForm />
        </Suspense>
      </div>
    </div>
  );
}
