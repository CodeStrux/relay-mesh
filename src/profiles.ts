/** The fleet: user-edited profiles.json, zod-validated. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Effort } from "./openrouter.js";

export type Role = "planner" | "recon" | "executor" | "monitor" | "verifier";

export interface Profile {
  name: string;
  role: Role;
  domain: string;
  area?: string;
  modelEnv: string;
  effort: Effort;
  prompt: string;
  multimodal: boolean;
  maxOutputTokens?: number;
}

/** Resolves to <repo>/profiles.json from both src/ (vitest) and dist/ (built). */
export const BUNDLED_PROFILES_PATH = fileURLToPath(
  new URL("../profiles.json", import.meta.url),
);

const profileSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["planner", "recon", "executor", "monitor", "verifier"]),
  domain: z.string().min(1),
  area: z.string().min(1).optional(),
  modelEnv: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  prompt: z.string().min(1),
  multimodal: z.boolean().default(false),
  maxOutputTokens: z.number().int().positive().optional(),
});

const fileSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(profileSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const names = new Set<string>();
    file.profiles.forEach((p, i) => {
      if (names.has(p.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate profile name "${p.name}"`,
          path: ["profiles", i, "name"],
        });
      }
      names.add(p.name);
    });

    for (const role of ["planner", "monitor", "verifier"] as const) {
      const count = file.profiles.filter((p) => p.role === role).length;
      if (count !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `expected exactly one "${role}" profile, found ${count}`,
          path: ["profiles"],
        });
      }
    }

    const areas = new Set<string>();
    file.profiles.forEach((p, i) => {
      if (p.role !== "executor") return;
      if (!p.area) {
        ctx.addIssue({
          code: "custom",
          message: `executor "${p.name}" must declare an area`,
          path: ["profiles", i, "area"],
        });
        return;
      }
      if (areas.has(p.area)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate executor area "${p.area}"`,
          path: ["profiles", i, "area"],
        });
      }
      areas.add(p.area);
    });
  });

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export async function loadProfiles(
  path: string = BUNDLED_PROFILES_PATH,
): Promise<Profile[]> {
  const raw = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path}: invalid profiles — ${formatIssues(parsed.error)}`);
  }
  return parsed.data.profiles;
}

export function byRole(profiles: Profile[], role: Role): Profile[] {
  return profiles.filter((p) => p.role === role);
}
