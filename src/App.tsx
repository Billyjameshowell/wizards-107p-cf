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
      <div className="page-message">
        <h1 >Wizards 107P</h1>
        <p >{error}</p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="page-message">
        Loading the book…
      </div>
    );
  }

  return <TicketBook book={book} repoStatus={{}} />;
}
