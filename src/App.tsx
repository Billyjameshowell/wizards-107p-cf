import { useEffect, useState } from "react";
import type { Book } from "@shared/book";
import { GridPage } from "./components/GridPage.tsx";
import { Loading, Message } from "./components/kit.tsx";
import { TicketBook } from "./components/TicketBook.tsx";
import { TrendsPage } from "./components/TrendsPage.tsx";

function pageKind(): "grid" | "trends" | "book" | "missing" {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/grid" || path.startsWith("/grid/")) return "grid";
  if (path === "/trends" || path.startsWith("/trends/")) return "trends";
  return path === "/" ? "book" : "missing";
}

export default function App() {
  const kind = pageKind();
  if (kind === "grid") return <GridPage />;
  if (kind === "trends") return <TrendsPage />;
  if (kind === "missing") return <Message title="This page isn't part of Wizards 107P" link={{ href: "/", label: "Go to the book" }} />;
  return <BookApp />;
}

function BookApp() {
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

  if (error) return <Message title="Wizards 107P" body={error} />;
  if (!book) return <Loading label="Opening the book" />;
  return <TicketBook book={book} repoStatus={{}} />;
}
