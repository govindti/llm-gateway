export async function safeReadText(response: Response): Promise<string> {
    try {
        return (await response.text()).replace(/\s+/g, " ").trim();
    } catch {
        return "";
    }
}

/** Keeps upstream error bodies short enough to store/log safely. */
export function truncate(value: string, max = 300): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
}

export function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, "");
}
