import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const detectInput = z.object({
  text: z.string().min(1).max(50_000),
});

/**
 * Server-side text detection. The API key stays in server environment
 * variables and is never sent to, or returned to, the browser.
 */
export const detectText = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => detectInput.parse(data))
  .handler(async ({ data }) => {
    const { detectAiText } = await import("./text-detection.server");
    const trimmed = data.text.trim();
    if (trimmed.split(/\s+/).filter(Boolean).length < 25) {
      throw new Error("Please provide at least 25 words — shorter passages cannot be reliably assessed.");
    }
    return await detectAiText(trimmed);
  });
