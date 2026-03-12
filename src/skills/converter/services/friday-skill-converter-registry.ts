import type {
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterDetection,
  FridaySkillSourceFormat,
} from "../model/friday-skill-converter.types.js";

// ─── Types ───

export interface FridaySkillConverterRegistry {
  register(converter: FridaySkillConverter): void;
  list(): ReadonlyArray<FridaySkillConverter>;
  detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null>;
  getConverter(id: string): FridaySkillConverter | undefined;
}

// ─── Implementation ───

export function createFridaySkillConverterRegistry(): FridaySkillConverterRegistry {
  const converters: FridaySkillConverter[] = [];

  return {
    register(converter: FridaySkillConverter): void {
      // Replace if already registered with same id
      const existingIndex = converters.findIndex((c) => c.id === converter.id);
      if (existingIndex !== -1) {
        converters[existingIndex] = converter;
      } else {
        converters.push(converter);
      }
    },

    list(): ReadonlyArray<FridaySkillConverter> {
      return converters;
    },

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      // If formatHint is provided and is not "auto", find converter by format
      if (source.formatHint && source.formatHint !== "auto") {
        return detectWithHint(converters, source, source.formatHint);
      }

      // Run all converters and pick best detection
      return detectBest(converters, source);
    },

    getConverter(id: string): FridaySkillConverter | undefined {
      return converters.find((c) => c.id === id);
    },
  };
}

// ─── Helpers ───

async function detectWithHint(
  converters: FridaySkillConverter[],
  source: FridaySkillConversionSource,
  hint: FridaySkillSourceFormat,
): Promise<FridaySkillConverterDetection | null> {
  // Run detection on all converters and find ones that match the hint format
  const detections: Array<{ converter: FridaySkillConverter; detection: FridaySkillConverterDetection }> = [];

  for (const converter of converters) {
    const detection = await converter.detect(source);
    if (detection && detection.format === hint) {
      detections.push({ converter, detection });
    }
  }

  if (detections.length === 0) {
    return null;
  }

  // Pick highest priority among matching
  detections.sort((a, b) => b.converter.priority - a.converter.priority);
  return detections[0]!.detection;
}

async function detectBest(
  converters: FridaySkillConverter[],
  source: FridaySkillConversionSource,
): Promise<FridaySkillConverterDetection | null> {
  const detections: Array<{ converter: FridaySkillConverter; detection: FridaySkillConverterDetection }> = [];

  for (const converter of converters) {
    const detection = await converter.detect(source);
    if (detection) {
      detections.push({ converter, detection });
    }
  }

  if (detections.length === 0) {
    return null;
  }

  // Sort by confidence desc, then priority desc
  detections.sort((a, b) => {
    const confDiff = b.detection.confidence - a.detection.confidence;
    if (confDiff !== 0) return confDiff;
    return b.converter.priority - a.converter.priority;
  });

  return detections[0]!.detection;
}
