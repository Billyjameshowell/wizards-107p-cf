import { useEffect, useState } from "react";
import type { Book } from "@shared/book";
import { TicketBook } from "./components/TicketBook.tsx";

export default function App() {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/book")
      .then((res) => {
        if (!res.ok) throw new Error("Could not load the book");
        return res.json() as Promise<Book>;
      })
      .then((data) => {
        if (!cancelled) setBook(data);
      })
      .catch(() => {
        if (!cancelled) setError("The book is unavailable right now. Try again in a minute.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-heading text-2xl text-navy">Wizards 107P</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div
        className="mx-auto max-w-[1180px] px-3 pt-4 sm:px-4 sm:pt-5"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="sr-only">Opening the book</p>
        <div className="h-32 animate-pulse rounded-2xl bg-navy/90" />
        <div className="mt-3 h-16 animate-pulse rounded-xl bg-white ring-1 ring-line" />
        <div className="mt-4 space-y-3 lg:hidden">
          <div className="h-44 animate-pulse rounded-2xl bg-white ring-1 ring-line" />
          <div className="h-44 animate-pulse rounded-2xl bg-white ring-1 ring-line" />
          <div className="h-44 animate-pulse rounded-2xl bg-white ring-1 ring-line" />
        </div>
        <div className="mt-4 hidden h-[420px] animate-pulse rounded-xl bg-white ring-1 ring-line lg:block" />
        <p className="mt-4 text-center text-sm text-muted-foreground">Opening the book…</p>
      </div>
    );
  }

  return <TicketBook book={book} repoStatus={{}} />;
}
