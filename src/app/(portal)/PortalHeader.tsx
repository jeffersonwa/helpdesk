"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Home, BookOpen, Ticket, LogOut } from "lucide-react";

/**
 * Cabeçalho leve do portal de autoatendimento (tarefa 34.1).
 *
 * Client Component apenas para o realce do link ativo (`usePathname`) e o
 * `signOut`. É intencionalmente mais simples que o `Sidebar` do console — sem
 * seções administrativas — pois o portal é para solicitantes/clientes.
 */
const navLinks = [
  { href: "/portal", label: "Início", icon: Home },
  { href: "/portal/kb", label: "Base de conhecimento", icon: BookOpen },
  { href: "/portal/tickets", label: "Meus chamados", icon: Ticket },
];

export default function PortalHeader({
  userName,
  companyName,
}: {
  userName: string;
  companyName: string;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/portal" ? pathname === "/portal" : pathname.startsWith(href);

  return (
    <header className="bg-white border-b sticky top-0 z-10">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.jpeg"
              alt={companyName}
              width={120}
              height={40}
              className="object-contain h-9 w-auto"
              priority
            />
            <span className="hidden sm:block text-xs text-gray-400">{companyName}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:block text-sm text-gray-500">{userName}</span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 transition-colors"
            >
              <LogOut size={16} /> Sair
            </button>
          </div>
        </div>

        <nav className="flex gap-1 -mb-px">
          {navLinks.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 transition-colors ${
                  active
                    ? "border-blue-600 text-blue-700 font-medium"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                <Icon size={16} /> {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
