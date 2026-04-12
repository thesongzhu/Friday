import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { ActionButton } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { saveCustomPack, type CustomPackInput } from "@/lib/packs/pack-registry";
import { skillsApi } from "@/lib/api/skills";
import { useAppLocale } from "@/providers/locale-provider";

export interface CustomPackBuilderProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function CustomPackBuilder({ open, onClose, onSaved }: CustomPackBuilderProps) {
  const { locale } = useAppLocale();

  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [entryPrompts, setEntryPrompts] = useState<string[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [skillSearch, setSkillSearch] = useState("");

  const skillsQuery = useQuery({
    queryKey: ["skills", "list-for-pack-builder"],
    queryFn: () => skillsApi.listSkills(),
    enabled: open,
  });

  const filteredSkills = (skillsQuery.data ?? [])
    .filter((s) =>
      skillSearch
        ? s.skillId.toLowerCase().includes(skillSearch.toLowerCase()) ||
          (s.name ?? "").toLowerCase().includes(skillSearch.toLowerCase())
        : true,
    )
    .slice(0, 20);

  const resetForm = useCallback(() => {
    setName("");
    setNameEn("");
    setDescription("");
    setDescriptionEn("");
    setSelectedSkillIds([]);
    setEntryPrompts([]);
    setCurrentPrompt("");
    setSkillSearch("");
  }, []);

  const handleSave = () => {
    if (!name.trim() || !description.trim()) return;

    const input: CustomPackInput = {
      name: name.trim(),
      nameEn: nameEn.trim(),
      description: description.trim(),
      descriptionEn: descriptionEn.trim(),
      skillIds: selectedSkillIds,
      entryPrompts,
    };

    saveCustomPack(input);
    resetForm();
    onSaved();
    onClose();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const addPrompt = () => {
    const trimmed = currentPrompt.trim();
    if (trimmed && !entryPrompts.includes(trimmed)) {
      setEntryPrompts((prev) => [...prev, trimmed]);
      setCurrentPrompt("");
    }
  };

  const removePrompt = (index: number) => {
    setEntryPrompts((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleSkill = (skillId: string) => {
    setSelectedSkillIds((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId],
    );
  };

  if (!open) return null;

  const canSave = name.trim().length > 0 && description.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative mx-4 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "\u521B\u5EFA\u81EA\u5B9A\u4E49\u5305", "Create Custom Pack")}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-hover)] hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u540D\u79F0", "Name")}
              <span className="text-[color:var(--color-danger)]"> *</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={localize(locale, "\u5305\u540D\u79F0", "Pack name")}
              className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>

          {/* English Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u82F1\u6587\u540D\u79F0", "English Name")}
            </label>
            <input
              type="text"
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
              placeholder={localize(locale, "\u82F1\u6587\u540D\u79F0\uFF08\u53EF\u9009\uFF09", "English name (optional)")}
              className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u63CF\u8FF0", "Description")}
              <span className="text-[color:var(--color-danger)]"> *</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={localize(locale, "\u63CF\u8FF0\u8FD9\u4E2A\u5305\u505A\u4EC0\u4E48", "What does this pack do?")}
              rows={2}
              className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>

          {/* English Description */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u82F1\u6587\u63CF\u8FF0", "English Description")}
            </label>
            <textarea
              value={descriptionEn}
              onChange={(e) => setDescriptionEn(e.target.value)}
              placeholder={localize(locale, "\u82F1\u6587\u63CF\u8FF0\uFF08\u53EF\u9009\uFF09", "English description (optional)")}
              rows={2}
              className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>

          {/* Skills selector */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u5173\u8054\u6280\u80FD", "Skills")}
            </label>
            <input
              type="text"
              value={skillSearch}
              onChange={(e) => setSkillSearch(e.target.value)}
              placeholder={localize(locale, "\u641C\u7D22\u6280\u80FD\u2026", "Search skills\u2026")}
              className="mb-2 w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
            />
            <div className="max-h-36 overflow-y-auto rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]">
              {skillsQuery.isLoading ? (
                <p className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">
                  {localize(locale, "\u52A0\u8F7D\u4E2D\u2026", "Loading\u2026")}
                </p>
              ) : filteredSkills.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">
                  {localize(locale, "\u6CA1\u6709\u627E\u5230\u6280\u80FD", "No skills found")}
                </p>
              ) : (
                filteredSkills.map((skill) => (
                  <label
                    key={skill.skillId}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-hover)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkillIds.includes(skill.skillId)}
                      onChange={() => toggleSkill(skill.skillId)}
                      className="rounded"
                    />
                    <span className="truncate text-[color:var(--color-text-primary)]">
                      {skill.name ?? skill.skillId}
                    </span>
                  </label>
                ))
              )}
            </div>
            {selectedSkillIds.length > 0 && (
              <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                {localize(locale, `\u5DF2\u9009 ${selectedSkillIds.length} \u4E2A\u6280\u80FD`, `${selectedSkillIds.length} skill(s) selected`)}
              </p>
            )}
          </div>

          {/* Entry Prompts */}
          <div>
            <label className="mb-1 block text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "\u5FEB\u6377\u5165\u53E3", "Entry Prompts")}
            </label>
            <div className="flex gap-2">
              <textarea
                value={currentPrompt}
                onChange={(e) => setCurrentPrompt(e.target.value)}
                placeholder={localize(locale, "\u8F93\u5165\u5FEB\u6377\u63D0\u793A\u8BCD\u2026", "Enter an entry prompt\u2026")}
                rows={2}
                className="flex-1 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] outline-none focus:border-[color:var(--color-accent)]"
              />
              <ActionButton tone="secondary" onClick={addPrompt} disabled={!currentPrompt.trim()}>
                {localize(locale, "\u6DFB\u52A0", "Add")}
              </ActionButton>
            </div>
            {entryPrompts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {entryPrompts.map((prompt, index) => (
                  <span
                    key={index}
                    className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-1 text-xs text-[color:var(--color-text-primary)]"
                  >
                    <span className="max-w-[200px] truncate">{prompt}</span>
                    <button
                      type="button"
                      onClick={() => removePrompt(index)}
                      className="ml-0.5 text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-primary)]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-[color:var(--color-border-soft)] px-6 py-4">
          <ActionButton tone="secondary" onClick={handleClose}>
            {localize(locale, "\u53D6\u6D88", "Cancel")}
          </ActionButton>
          <ActionButton onClick={handleSave} disabled={!canSave}>
            {localize(locale, "\u4FDD\u5B58", "Save")}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
