const link =
  "inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-[#f3e6c8] underline decoration-[#f3e6c8]/70 underline-offset-4";
const current = "inline-flex min-h-11 items-center px-2 text-sm font-semibold text-white";

export function SiteNav({
  current: page,
  admin = false,
}: {
  current: "book" | "trends" | "grid";
  admin?: boolean;
}) {
  return (
    <nav aria-label="Site" className="flex shrink-0 items-center gap-1">
      {page === "book" ? (
        <span className={current} aria-current="page">
          Book
        </span>
      ) : (
        <a href="/" className={link}>
          Book
        </a>
      )}
      {page === "trends" ? (
        <span className={current} aria-current="page">
          Trends
        </span>
      ) : (
        <a href="/trends" className={link}>
          Trends
        </a>
      )}
      {page === "grid" ? (
        <span className={current} aria-current="page">
          Grid
        </span>
      ) : (
        <a href="/grid" className={link}>
          Grid
        </a>
      )}
      {admin ? (
        <a href="/admin" className={link}>
          Admin
        </a>
      ) : null}
    </nav>
  );
}
