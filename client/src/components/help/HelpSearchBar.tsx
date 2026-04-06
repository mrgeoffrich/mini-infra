import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { IconSearch, IconFileText, IconX } from "@tabler/icons-react";
import { useDocSearch } from "@/lib/doc-search";
import { getCategoryLabel } from "@/lib/doc-loader";
import { cn } from "@/lib/utils";

export function HelpSearchBar() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const results = useDocSearch(query);
  const isSearching = query.trim().length > 0;
  const displayResults = isSearching ? results.slice(0, 8) : [];

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-search-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (href: string) => {
      navigate(href);
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [navigate]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || displayResults.length === 0) {
      if (e.key === "Escape") {
        setQuery("");
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, displayResults.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        handleSelect(displayResults[selectedIndex].href);
        break;
      case "Escape":
        e.preventDefault();
        setQuery("");
        setOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-xl">
      <div className="relative">
        <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (isSearching) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search documentation..."
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          className="h-8 w-full rounded-md border border-input bg-muted/50 pl-9 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:bg-background transition-colors"
        />
        {isSearching && (
          <button
            onClick={() => {
              setQuery("");
              setOpen(false);
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <IconX className="size-3.5" />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {open && isSearching && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border bg-popover shadow-md overflow-hidden">
          <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {displayResults.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No results found.
              </p>
            ) : (
              displayResults.map((doc, index) => (
                <button
                  key={doc.href}
                  data-search-item
                  onClick={() => handleSelect(doc.href)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    "flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm transition-colors",
                    index === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground"
                  )}
                >
                  <IconFileText className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {doc.frontmatter.title}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {getCategoryLabel(doc.category)}
                      {doc.frontmatter.description &&
                        ` — ${doc.frontmatter.description}`}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
          {displayResults.length > 0 && (
            <div className="border-t px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-2">
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
                ↑↓
              </kbd>
              <span>navigate</span>
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
                ↵
              </kbd>
              <span>open</span>
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
                esc
              </kbd>
              <span>close</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
