import { serviceUnavailable } from "@/utils/errors";
import type { LLMProvider, ProviderName } from "./types";

/**
 * Holds every known provider and decides which ones may serve a request.
 * Keeping the ordering here (instead of in the chat service) makes fallback
 * policy a single, testable concern - add a third provider and it joins the
 * chain automatically.
 */
export class ProviderRegistry {
    private readonly providers: Map<ProviderName, LLMProvider>;

    constructor(providers: LLMProvider[]) {
        this.providers = new Map(providers.map((provider) => [provider.name, provider]));
    }

    get(name: ProviderName): LLMProvider | undefined {
        return this.providers.get(name);
    }

    isConfigured(name: ProviderName): boolean {
        return this.providers.get(name)?.isConfigured() ?? false;
    }

    names(): ProviderName[] {
        return [...this.providers.keys()];
    }

    /**
     * Attempt order for a request: the requested provider first, then every other
     * configured provider as fallback. Providers without credentials are skipped.
     */
    resolveChain(primary: ProviderName): LLMProvider[] {
        const primaryProvider = this.providers.get(primary);
        const fallbacks = [...this.providers.values()].filter((provider) => provider.name !== primary);

        const ordered = primaryProvider ? [primaryProvider, ...fallbacks] : fallbacks;
        const chain = ordered.filter((provider) => provider.isConfigured());

        if (chain.length === 0) {
            throw serviceUnavailable(
                "No LLM provider is configured. Set OPENAI_API_KEY and/or GEMINI_API_KEY.",
                "no_provider_configured",
            );
        }

        return chain;
    }
}
