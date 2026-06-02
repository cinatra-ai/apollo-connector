"use client";

import { useImperativeHandle, useState } from "react";
import { WidgetShell, type WidgetProps } from "@cinatra-ai/sdk-ui";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { PaginatedTable } from "../components/ui/paginated-table";

type Person = {
  name: string;
  title?: string;
  email?: string;
  emailStatus?: string;
  linkedinUrl?: string;
  company?: string;
  location?: string;
};

type SearchResult = {
  people: Person[];
  pagination?: { total_entries?: number };
};

export function PeopleSearchWidget({ resourceId, onSave, submitRef }: WidgetProps) {
  // resourceId = company domain or name to search.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Person[] | null>(null);
  const [titles, setTitles] = useState("CEO, CTO, VP Marketing");

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: `Search Apollo for people at "${resourceId}" with titles: ${titles}. Return results as JSON.`,
          }],
        }),
      });
      if (!response.ok) throw new Error("Search failed.");
      // For now, we can't easily parse the streaming response for structured data.
      // Show a message to the user instead.
      if (onSave) onSave({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  useImperativeHandle(submitRef, () => ({ submit: async () => { await search(); return true; } }));

  return (
    <WidgetShell label="Apollo search" loading={false} error={error}>
      <div className="grid gap-4 rounded-panel border border-line bg-surface-strong p-4">
        <p className="text-sm font-semibold text-foreground">Search Apollo People</p>
        <p className="text-sm text-muted-foreground">Company: <strong>{resourceId}</strong></p>
        <Label className="grid gap-2 text-sm font-medium leading-normal">
          <span>Target titles</span>
          <Input
            type="text"
            value={titles}
            onChange={(e) => setTitles(e.target.value)}
            placeholder="CEO, CTO, VP Marketing"
            className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm outline-none transition focus:border-border"
          />
        </Label>
        {loading && <p className="text-xs text-muted-foreground">Searching...</p>}
        {results && (
            <PaginatedTable className="min-w-full text-sm">
              <TableHeader>
                <TableRow className="bg-surface-muted">
                  <TableHead className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Name</TableHead>
                  <TableHead className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Title</TableHead>
                  <TableHead className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Email</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((person, i) => (
                  <TableRow key={i} className="border-t border-line">
                    <TableCell className="px-3 py-2 text-foreground">{person.name}</TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">{person.title ?? "—"}</TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">{person.email ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </PaginatedTable>
        )}
      </div>
    </WidgetShell>
  );
}
