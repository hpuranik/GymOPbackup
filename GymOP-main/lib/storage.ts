import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, list, put } from "@vercel/blob";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GymUpload } from "./story1";

export type GymSettings = {
  limits: Record<string, number>;
  placements: Record<string, { x: number; y: number }>;
  hasFloorPlan: boolean;
  events: { at: string; message: string; type?: string }[];
};

const emptySettings = (): GymSettings => ({
  limits: {},
  placements: {},
  hasFloorPlan: false,
  events: [],
});

export function normalizeGymName(name: string) {
  return name.trim().toLowerCase();
}

function safeGymName(name: string) {
  return Buffer.from(normalizeGymName(name), "utf8").toString("base64url") || "unnamed";
}

function useSupabaseStorage() {
  return Boolean(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin() {
  if (!useSupabaseStorage()) {
    throw new Error("Supabase server credentials are not configured.");
  }
  if (!supabaseAdmin) {
    const url = process.env.SUPABASE_URL!;
    const key =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY!;
    supabaseAdmin = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return supabaseAdmin;
}

function useBlobStorage() {
  if (process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN && !useSupabaseStorage()) {
    throw new Error("Persistent storage is not configured. Configure Supabase or Vercel Blob.");
  }
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function localDirectory(gymName: string) {
  return path.join(process.cwd(), ".gymop-data", safeGymName(gymName));
}

function blobPath(gymName: string, week: string) {
  return `gymop/${safeGymName(gymName)}/${week}.json`;
}

function settingsFile(gymName: string) {
  return path.join(localDirectory(gymName), "settings.json");
}

function settingsBlob(gymName: string) {
  return `gymop/${safeGymName(gymName)}/settings.json`;
}

function floorPlanFile(gymName: string) {
  return path.join(localDirectory(gymName), "floor-plan.png");
}

function floorPlanBlob(gymName: string) {
  return `gymop/${safeGymName(gymName)}/floor-plan.png`;
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function throwSupabaseError(error: { message: string } | null) {
  if (error) throw new Error(`Supabase storage operation failed: ${error.message}`);
}

export function olderThanFiveYears(week: string, today = new Date().toISOString().slice(0, 10)) {
  const date = new Date(`${week}T00:00:00Z`);
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
  return !Number.isNaN(date.getTime()) && date < cutoff;
}

async function getBlobText(pathname: string) {
  const result = await get(pathname, { access: "private", useCache: false });
  return result ? new Response(result.stream).text() : null;
}

export async function findWeek(gymName: string, week: string): Promise<GymUpload | null> {
  if (useSupabaseStorage()) {
    const { data, error } = await getSupabaseAdmin()
      .from("gymop_weekly_uploads")
      .select("payload")
      .eq("gym_name", normalizeGymName(gymName))
      .eq("week_start_date", week)
      .maybeSingle();
    throwSupabaseError(error);
    return (data?.payload as GymUpload | undefined) ?? null;
  }

  if (useBlobStorage()) {
    const text = await getBlobText(blobPath(gymName, week));
    return text ? (JSON.parse(text) as GymUpload) : null;
  }

  try {
    const text = await readFile(path.join(localDirectory(gymName), `${week}.json`), "utf8");
    return JSON.parse(text) as GymUpload;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function saveWeek(upload: GymUpload) {
  if (useSupabaseStorage()) {
    const { error } = await getSupabaseAdmin()
      .from("gymop_weekly_uploads")
      .upsert(
        {
          gym_name: normalizeGymName(upload.gymName),
          week_start_date: upload.weekStartDate,
          uploaded_at: upload.uploadedAt,
          row_count: upload.rows.length,
          payload: upload,
        },
        { onConflict: "gym_name,week_start_date" },
      );
    throwSupabaseError(error);
    return;
  }

  if (useBlobStorage()) {
    await put(blobPath(upload.gymName, upload.weekStartDate), JSON.stringify(upload), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
    });
    return;
  }

  const directory = localDirectory(upload.gymName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${upload.weekStartDate}.json`),
    JSON.stringify(upload, null, 2),
    "utf8",
  );
}

export async function listWeeks(gymName: string): Promise<GymUpload[]> {
  if (useSupabaseStorage()) {
    const { data, error } = await getSupabaseAdmin()
      .from("gymop_weekly_uploads")
      .select("payload, week_start_date")
      .eq("gym_name", normalizeGymName(gymName))
      .order("week_start_date", { ascending: false });
    throwSupabaseError(error);

    const expired = (data ?? []).filter((record) =>
      olderThanFiveYears(String(record.week_start_date)),
    );
    if (expired.length) {
      const { error: deleteError } = await getSupabaseAdmin()
        .from("gymop_weekly_uploads")
        .delete()
        .eq("gym_name", normalizeGymName(gymName))
        .in("week_start_date", expired.map((record) => String(record.week_start_date)));
      throwSupabaseError(deleteError);
    }
    return (data ?? [])
      .filter((record) => !olderThanFiveYears(String(record.week_start_date)))
      .map((record) => record.payload as GymUpload);
  }

  if (useBlobStorage()) {
    const prefix = `gymop/${safeGymName(gymName)}/`;
    const result = await list({ prefix });
    const records = result.blobs.filter((blob) => /^\d{4}-\d{2}-\d{2}\.json$/.test(path.posix.basename(blob.pathname)));
    const expired = records.filter((blob) => olderThanFiveYears(path.posix.basename(blob.pathname).slice(0, 10)));
    if (expired.length) await del(expired.map((blob) => blob.pathname));
    const uploads = await Promise.all(
      records
        .filter((blob) => !olderThanFiveYears(path.posix.basename(blob.pathname).slice(0, 10)))
        .map(async (blob) => {
          const data = await get(blob.url, { access: "private", useCache: false });
          return data ? (JSON.parse(await new Response(data.stream).text()) as GymUpload) : null;
        }),
    );
    return uploads
      .filter((item): item is GymUpload => item !== null)
      .sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate));
  }

  const fs = await import("node:fs/promises");
  let names: string[];
  try {
    names = await fs.readdir(localDirectory(gymName));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const uploads: GymUpload[] = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const week = name.slice(0, 10);
    if (olderThanFiveYears(week)) {
      await unlink(path.join(localDirectory(gymName), name));
      continue;
    }
    const text = await readFile(path.join(localDirectory(gymName), name), "utf8");
    uploads.push(JSON.parse(text) as GymUpload);
  }
  return uploads.sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate));
}

export async function getGymSettings(gymName: string): Promise<GymSettings> {
  if (useSupabaseStorage()) {
    const { data, error } = await getSupabaseAdmin()
      .from("gymop_gym_settings")
      .select("settings")
      .eq("gym_name", normalizeGymName(gymName))
      .maybeSingle();
    throwSupabaseError(error);
    return { ...emptySettings(), ...(data?.settings as Partial<GymSettings> | undefined) };
  }

  if (useBlobStorage()) {
    const text = await getBlobText(settingsBlob(gymName));
    return text ? ({ ...emptySettings(), ...JSON.parse(text) } as GymSettings) : emptySettings();
  }
  try {
    const text = await readFile(settingsFile(gymName), "utf8");
    return { ...emptySettings(), ...JSON.parse(text) } as GymSettings;
  } catch (error) {
    if (isMissingFile(error)) return emptySettings();
    throw error;
  }
}

export async function saveGymSettings(gymName: string, settings: GymSettings) {
  if (useSupabaseStorage()) {
    const { error } = await getSupabaseAdmin()
      .from("gymop_gym_settings")
      .upsert(
        { gym_name: normalizeGymName(gymName), settings, updated_at: new Date().toISOString() },
        { onConflict: "gym_name" },
      );
    throwSupabaseError(error);
    return;
  }

  if (useBlobStorage()) {
    await put(settingsBlob(gymName), JSON.stringify(settings), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
    });
    return;
  }
  const directory = localDirectory(gymName);
  await mkdir(directory, { recursive: true });
  await writeFile(settingsFile(gymName), JSON.stringify(settings, null, 2), "utf8");
}

export async function getFloorPlan(gymName: string) {
  if (useSupabaseStorage()) {
    const { data, error } = await getSupabaseAdmin()
      .storage.from("gymop-floor-plans")
      .download(`${safeGymName(gymName)}/floor-plan.png`);
    if (error) {
      if (/not found|object not found/i.test(error.message)) return null;
      throw new Error(`Supabase floor-plan download failed: ${error.message}`);
    }
    return data ? Buffer.from(await data.arrayBuffer()) : null;
  }

  if (useBlobStorage()) {
    const result = await get(floorPlanBlob(gymName), { access: "private", useCache: false });
    return result ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
  }
  try {
    return await readFile(floorPlanFile(gymName));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function saveFloorPlan(gymName: string, image: Buffer) {
  if (useSupabaseStorage()) {
    const { error } = await getSupabaseAdmin()
      .storage.from("gymop-floor-plans")
      .upload(`${safeGymName(gymName)}/floor-plan.png`, image, {
        contentType: "image/png",
        upsert: true,
      });
    throwSupabaseError(error);
    return;
  }

  if (useBlobStorage()) {
    await put(floorPlanBlob(gymName), image, {
      access: "private",
      allowOverwrite: true,
      contentType: "image/png",
    });
    return;
  }
  const directory = localDirectory(gymName);
  await mkdir(directory, { recursive: true });
  await writeFile(floorPlanFile(gymName), image);
}
