"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { LayoutDashboard, Ticket, Users, BarChart2, LogOut, UserCircle, Building2 } from "lucide-react";

const links = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tickets", label: "Tickets", icon: Ticket },
  { href: "/users", label: "Usuários", icon: Users, roles: ["ADMIN", "SUPERADMIN"] },
  { href: "/companies", label: "Empresas", icon: Building2, roles: ["SUPERADMIN"] },
  { href: "/reports", label: "Relatórios", icon: BarChart2, roles: ["ADMIN", "SUPERADMIN", "AGENT"] },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role ?? "";

  return (
    <aside className="w-64 min-h-screen bg-white border-r flex flex-col">
      <div className="p-6 border-b">
        <h1 className="font-bold text-lg text-blue-600">Helpdesk</h1>
        <p className="text-xs text-gray-500 mt-1">{session?.user?.companyName}</p>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {links.map(({ href, label, icon: Icon, roles }) => {
          if (roles && !roles.includes(role)) return null;
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t">
        <div className="text-sm text-gray-700 font-medium mb-0.5">{session?.user?.name}</div>
        <div className="text-xs text-gray-400 mb-3">{session?.user?.email}</div>
        <div className="flex flex-col gap-1">
          <Link href="/profile" className="flex items-center gap-2 text-sm text-gray-500 hover:text-blue-600 transition-colors">
            <UserCircle size={16} /> Minha conta
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-red-600 transition-colors"
          >
            <LogOut size={16} /> Sair
          </button>
        </div>
      </div>
    </aside>
  );
}
