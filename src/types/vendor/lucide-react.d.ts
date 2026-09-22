// Tipos para `lucide-react` (ver nota em ./next-auth.d.ts).
//
// A versão instalada não materializa o `dist/lucide-react.d.ts` apontado por
// `typings`, então declaramos aqui os ícones usados no projeto. Todos têm o
// mesmo tipo `LucideIcon`. Ao usar um ícone novo, adicione-o a esta lista
// (o `tsc`/build acusará "no exported member" caso falte). Mapeado via `paths`,
// portanto vale só para o type-check; o runtime usa o `.js` real do pacote.
import type { FC, SVGProps } from "react";

export type LucideProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
};
export type LucideIcon = FC<LucideProps>;

export const LayoutDashboard: LucideIcon;
export const Ticket: LucideIcon;
export const Users: LucideIcon;
export const BarChart2: LucideIcon;
export const LogOut: LucideIcon;
export const UserCircle: LucideIcon;
export const Building2: LucideIcon;
export const MessagesSquare: LucideIcon;
export const Inbox: LucideIcon;
export const BookOpen: LucideIcon;
export const ShieldCheck: LucideIcon;
export const Radio: LucideIcon;
export const Home: LucideIcon;
export const Plus: LucideIcon;
export const ArrowRight: LucideIcon;
export const ArrowLeft: LucideIcon;
export const Search: LucideIcon;
export const AlertTriangle: LucideIcon;
export const HelpCircle: LucideIcon;
