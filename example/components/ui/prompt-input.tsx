"use client";

import * as React from "react";
import {
  AtSign,
  ChevronDown,
  Code2,
  FileCode,
  FileText,
  FolderTree,
  Image,
  Paperclip,
  Send,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Reference {
  id: string;
  type: "file" | "folder" | "codebase" | "docs" | "web" | "image";
  name: string;
  path?: string;
}

interface MentionOption {
  id: string;
  type: Reference["type"];
  name: string;
  description?: string;
  path?: string;
  icon: React.ReactNode;
}

const MENTION_OPTIONS: MentionOption[] = [
  {
    id: "codebase",
    type: "codebase",
    name: "Codebase",
    description: "Search entire codebase",
    icon: <FolderTree className="h-4 w-4" />,
  },
  {
    id: "docs",
    type: "docs",
    name: "Docs",
    description: "Search documentation",
    icon: <FileText className="h-4 w-4" />,
  },
  {
    id: "web",
    type: "web",
    name: "Web",
    description: "Search the web",
    icon: <Sparkles className="h-4 w-4" />,
  },
  {
    id: "file-1",
    type: "file",
    name: "page.tsx",
    path: "app/page.tsx",
    icon: <FileCode className="h-4 w-4" />,
  },
  {
    id: "file-2",
    type: "file",
    name: "layout.tsx",
    path: "app/layout.tsx",
    icon: <FileCode className="h-4 w-4" />,
  },
  {
    id: "file-3",
    type: "file",
    name: "globals.css",
    path: "app/globals.css",
    icon: <Code2 className="h-4 w-4" />,
  },
  {
    id: "file-4",
    type: "file",
    name: "utils.ts",
    path: "lib/utils.ts",
    icon: <FileCode className="h-4 w-4" />,
  },
  {
    id: "folder-1",
    type: "folder",
    name: "components",
    path: "components/",
    icon: <FolderTree className="h-4 w-4" />,
  },
  {
    id: "folder-2",
    type: "folder",
    name: "app",
    path: "app/",
    icon: <FolderTree className="h-4 w-4" />,
  },
  {
    id: "image-1",
    type: "image",
    name: "screenshot.png",
    path: "public/screenshot.png",
    icon: <Image className="h-4 w-4" />,
  },
];

const MODELS = [
  { id: "claude-4", name: "Claude 4 Opus", provider: "Anthropic" },
  { id: "gpt-5", name: "GPT-5", provider: "OpenAI" },
  { id: "claude-sonnet", name: "Claude 4 Sonnet", provider: "Anthropic" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "OpenAI" },
  { id: "gemini-3", name: "Gemini 3 Pro", provider: "Google" },
];

export function CursorPromptInput() {
  const [value, setValue] = React.useState("");
  const [references, setReferences] = React.useState<Reference[]>([]);
  const [showMentionMenu, setShowMentionMenu] = React.useState(false);
  const [mentionFilter, setMentionFilter] = React.useState("");
  const [selectedMentionIndex, setSelectedMentionIndex] = React.useState(0);
  const [showModelMenu, setShowModelMenu] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState(MODELS[0]);
  const [isFocused, setIsFocused] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionMenuRef = React.useRef<HTMLDivElement>(null);
  const modelMenuRef = React.useRef<HTMLDivElement>(null);

  const filteredMentions = MENTION_OPTIONS.filter(
    (option) =>
      option.name.toLowerCase().includes(mentionFilter.toLowerCase()) ||
      option.path?.toLowerCase().includes(mentionFilter.toLowerCase()),
  );

  // Handle textarea resize
  React.useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  // Handle click outside to close menus
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        mentionMenuRef.current &&
        !mentionMenuRef.current.contains(e.target as Node)
      ) {
        setShowMentionMenu(false);
      }
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setShowModelMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reset selected index when filter changes
  React.useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionFilter]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);

    // Check for @ trigger
    const lastAtIndex = newValue.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      const textAfterAt = newValue.slice(lastAtIndex + 1);
      const hasSpaceAfterAt = textAfterAt.includes(" ");
      if (!hasSpaceAfterAt) {
        setShowMentionMenu(true);
        setMentionFilter(textAfterAt);
      } else {
        setShowMentionMenu(false);
        setMentionFilter("");
      }
    } else {
      setShowMentionMenu(false);
      setMentionFilter("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIndex((prev) =>
          prev < filteredMentions.length - 1 ? prev + 1 : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIndex((prev) =>
          prev > 0 ? prev - 1 : filteredMentions.length - 1,
        );
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (filteredMentions[selectedMentionIndex]) {
          selectMention(filteredMentions[selectedMentionIndex]);
        }
      } else if (e.key === "Escape") {
        setShowMentionMenu(false);
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const selectMention = (option: MentionOption) => {
    // Remove the @filter text and add the reference
    const lastAtIndex = value.lastIndexOf("@");
    const newValue = value.slice(0, lastAtIndex);
    setValue(newValue);

    const newRef: Reference = {
      id: option.id,
      type: option.type,
      name: option.name,
      path: option.path,
    };

    if (!references.find((r) => r.id === option.id)) {
      setReferences([...references, newRef]);
    }

    setShowMentionMenu(false);
    setMentionFilter("");
    textareaRef.current?.focus();
  };

  const removeReference = (id: string) => {
    setReferences(references.filter((r) => r.id !== id));
  };

  const handleSubmit = () => {
    if (!value.trim() && references.length === 0) return;
    // Here you would handle the submission
    console.log("Submitting:", { value, references, model: selectedModel });
    setValue("");
    setReferences([]);
  };

  const getReferenceIcon = (type: Reference["type"]) => {
    switch (type) {
      case "file":
        return <FileCode className="h-3 w-3" />;
      case "folder":
        return <FolderTree className="h-3 w-3" />;
      case "codebase":
        return <FolderTree className="h-3 w-3" />;
      case "docs":
        return <FileText className="h-3 w-3" />;
      case "web":
        return <Sparkles className="h-3 w-3" />;
      case "image":
        return <Image className="h-3 w-3" />;
      default:
        return <FileCode className="h-3 w-3" />;
    }
  };

  const getReferenceColor = (type: Reference["type"]) => {
    switch (type) {
      case "codebase":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "docs":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "web":
        return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      case "file":
        return "bg-sky-500/20 text-sky-400 border-sky-500/30";
      case "folder":
        return "bg-indigo-500/20 text-indigo-400 border-indigo-500/30";
      case "image":
        return "bg-pink-500/20 text-pink-400 border-pink-500/30";
      default:
        return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto">
      {/* Main Input Container */}
      <div
        className={cn(
          "relative rounded-xl border bg-zinc-900/80 backdrop-blur-sm transition-all duration-200",
          isFocused
            ? "border-zinc-600 ring-1 ring-zinc-600/50 shadow-lg shadow-black/20"
            : "border-zinc-800 hover:border-zinc-700",
        )}
      >
        {/* References Pills */}
        {references.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {references.map((ref) => (
              <div
                key={ref.id}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border",
                  getReferenceColor(ref.type),
                )}
              >
                {getReferenceIcon(ref.type)}
                <span>{ref.path || ref.name}</span>
                <button
                  onClick={() => removeReference(ref.id)}
                  className="ml-0.5 hover:opacity-70 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Ask anything... Use @ to reference files"
            rows={1}
            className={cn(
              "w-full resize-none bg-transparent px-4 py-3 text-sm text-zinc-100",
              "placeholder:text-zinc-500 focus:outline-none",
              references.length > 0 ? "pt-2" : "",
            )}
          />
        </div>

        {/* Bottom Bar */}
        <div className="flex items-center justify-between px-3 pb-3">
          {/* Left Actions */}
          <div className="flex items-center gap-1">
            {/* Add Reference Button */}
            <button
              onClick={() => {
                setValue(value + "@");
                setShowMentionMenu(true);
                textareaRef.current?.focus();
              }}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              <AtSign className="h-3.5 w-3.5" />
              <span>Add context</span>
            </button>

            {/* Attach File */}
            <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <Paperclip className="h-4 w-4" />
            </button>

            {/* Terminal */}
            <button className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <Terminal className="h-4 w-4" />
            </button>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            {/* Model Selector */}
            <div className="relative" ref={modelMenuRef}>
              <button
                onClick={() => setShowModelMenu(!showModelMenu)}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span>{selectedModel.name}</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              {/* Model Menu */}
              {showModelMenu && (
                <div className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40 overflow-hidden z-50">
                  <div className="px-3 py-2 border-b border-zinc-800">
                    <p className="text-xs font-medium text-zinc-400">
                      Select Model
                    </p>
                  </div>
                  <div className="py-1">
                    {MODELS.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => {
                          setSelectedModel(model);
                          setShowModelMenu(false);
                        }}
                        className={cn(
                          "w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-zinc-800 transition-colors",
                          selectedModel.id === model.id
                            ? "text-zinc-100"
                            : "text-zinc-400",
                        )}
                      >
                        <span>{model.name}</span>
                        <span className="text-xs text-zinc-600">
                          {model.provider}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Submit Button */}
            <button
              onClick={handleSubmit}
              disabled={!value.trim() && references.length === 0}
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-lg transition-all",
                value.trim() || references.length > 0
                  ? "bg-zinc-100 text-zinc-900 hover:bg-white"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed",
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mention Menu */}
        {showMentionMenu && (
          <div
            ref={mentionMenuRef}
            className="absolute left-0 right-0 bottom-full mb-2 mx-3 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40 overflow-hidden z-50"
          >
            <div className="px-3 py-2 border-b border-zinc-800">
              <p className="text-xs font-medium text-zinc-400">
                {mentionFilter
                  ? `Searching for "${mentionFilter}"`
                  : "Reference context"}
              </p>
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredMentions.length > 0 ? (
                filteredMentions.map((option, index) => (
                  <button
                    key={option.id}
                    onClick={() => selectMention(option)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                      index === selectedMentionIndex
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-800/50",
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-center justify-center w-6 h-6 rounded",
                        option.type === "codebase"
                          ? "text-emerald-400"
                          : option.type === "docs"
                            ? "text-blue-400"
                            : option.type === "web"
                              ? "text-amber-400"
                              : option.type === "file"
                                ? "text-sky-400"
                                : option.type === "folder"
                                  ? "text-indigo-400"
                                  : option.type === "image"
                                    ? "text-pink-400"
                                    : "text-zinc-400",
                      )}
                    >
                      {option.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {option.name}
                      </p>
                      {(option.path || option.description) && (
                        <p className="text-xs text-zinc-500 truncate">
                          {option.path || option.description}
                        </p>
                      )}
                    </div>
                    <span className="text-[10px] text-zinc-600 uppercase tracking-wider">
                      {option.type}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-6 text-center text-sm text-zinc-500">
                  No results found
                </div>
              )}
            </div>
            <div className="px-3 py-2 border-t border-zinc-800 flex items-center gap-4 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  ↵
                </kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  esc
                </kbd>
                Close
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Hint */}
      <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-400 font-mono">
            @
          </kbd>
          to reference
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-400 font-mono">
            Enter
          </kbd>
          to send
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-400 font-mono">
            Shift + Enter
          </kbd>
          new line
        </span>
      </div>
    </div>
  );
}
