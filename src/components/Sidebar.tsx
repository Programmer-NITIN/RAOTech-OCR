"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  UploadCloud,
  FileSpreadsheet,
  MessageSquare,
  MessagesSquare,
  LogOut,
  BookOpen,
  ListChecks,
  Scale,
  BarChart3,
  Kanban,
  Link2,
  ClipboardList,
  Filter,
  Building2,
  PlugZap,
  Settings,
} from "lucide-react";
import { SignOutButton } from "@clerk/nextjs";
import { extraPagesEnabled } from "@/lib/featureFlags";

const routes = [
  { label: "Dashboard", icon: LayoutGrid, href: "/dashboard" },
  { label: "All Clients", icon: Building2, href: "/clients" },
  { label: "Pipeline", icon: Kanban, href: "/pipeline", localOnly: true },
  { label: "Upload", icon: UploadCloud, href: "/upload" },
  { label: "Review queue", icon: Filter, href: "/review", localOnly: true },
  { label: "Sheet Upload", icon: FileSpreadsheet, href: "/sheets" },
  { label: "Transactions", icon: ListChecks, href: "/transactions" },
  { label: "GST Recon", icon: Scale, href: "/gst", localOnly: true },
  { label: "Reports", icon: BarChart3, href: "/reports", localOnly: true },
  { label: "Ledgers & Rules", icon: BookOpen, href: "/settings", exact: true },
  { label: "Tally Connection", icon: PlugZap, href: "/settings/tally" },
  { label: "Intake Links", icon: Link2, href: "/intake", localOnly: true },
  { label: "Tasks", icon: ClipboardList, href: "/tasks", localOnly: true },
  { label: "AI Assistant", icon: MessageSquare, href: "/pricing" },
  { label: "Communication", icon: MessagesSquare, href: "/communication", localOnly: true },
];

type SidebarProps = {
  onNavigate?: () => void;
};

export function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const showExtraPages = extraPagesEnabled();
  const visibleRoutes = routes.filter((route) => showExtraPages || !route.localOnly);

  const logNavClick = (href: string, label: string) => {
    if (process.env.NEXT_PUBLIC_TRACE_LOGS === "0") return;
    console.log("[trace][sidebar] nav:click", {
      from: pathname,
      to: href,
      label,
      at: new Date().toISOString(),
    });
  };

  const isSettingsActive = pathname === "/app-settings" || pathname.startsWith("/app-settings/");

  return (
    <div
      className="flex flex-col h-full bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 border-r border-neutral-200/80 dark:border-neutral-800"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      {/* ── Brand Header ── */}
      <div className="px-6 pt-6 pb-5">
        <Link href="/dashboard" className="block group">
          <h1 className="text-xl font-bold tracking-tight uppercase text-neutral-900 dark:text-white">
            RAO TECH
          </h1>
          <p className="text-[10px] font-semibold tracking-[0.2em] text-neutral-400 dark:text-neutral-500 uppercase mt-0.5">
            OPERATIONAL CENTER
          </p>
        </Link>
      </div>

      {/* ── Navigation List ── */}
      <nav className="flex-1 min-h-0 px-3 py-2 space-y-1 overflow-y-auto overscroll-contain">
        {visibleRoutes.map((route) => {
          const isActive =
            pathname === route.href ||
            (!("exact" in route && route.exact) && pathname.startsWith(route.href + "/"));

          return (
            <Link
              key={route.href}
              href={route.href}
              onClick={() => {
                logNavClick(route.href, route.label);
                onNavigate?.();
              }}
              className={`flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/80 dark:text-neutral-400 dark:hover:text-white dark:hover:bg-neutral-800/60"
              }`}
            >
              <route.icon
                className={`h-5 w-5 shrink-0 transition-colors ${
                  isActive
                    ? "text-white dark:text-neutral-900"
                    : "text-neutral-600 dark:text-neutral-400"
                }`}
                strokeWidth={2}
              />
              <span className="tracking-wide">{route.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* ── Bottom Section: Settings & Logout ── */}
      <div className="px-3 py-3 border-t border-neutral-100 dark:border-neutral-800 space-y-1">
        {/* Settings */}
        <Link
          href="/app-settings"
          onClick={() => {
            logNavClick("/app-settings", "Settings");
            onNavigate?.();
          }}
          className={`flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm font-medium transition-all duration-150 ${
            isSettingsActive
              ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-sm"
              : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/80 dark:text-neutral-400 dark:hover:text-white dark:hover:bg-neutral-800/60"
          }`}
        >
          <Settings
            className={`h-5 w-5 shrink-0 transition-colors ${
              isSettingsActive
                ? "text-white dark:text-neutral-900"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
            strokeWidth={2}
          />
          <span className="tracking-wide">Settings</span>
        </Link>

        {/* Logout */}
        <SignOutButton>
          <button
            type="button"
            onClick={onNavigate}
            className="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/80 dark:text-neutral-400 dark:hover:text-white dark:hover:bg-neutral-800/60 transition-all duration-150"
          >
            <LogOut className="h-5 w-5 shrink-0 text-neutral-600 dark:text-neutral-400" strokeWidth={2} />
            <span className="tracking-wide">Logout</span>
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
