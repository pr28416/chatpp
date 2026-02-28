"use client"

import { useState } from "react"
import { Topic, Subtopic, Moment, timelineData } from "@/lib/timeline-data"
import { TopicSidebar } from "./topic-sidebar"
import { OutlinePane } from "./outline-pane"
import { MessagePane } from "./message-pane"
import { PanelLeftClose, PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"

export function TimelineView() {
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(timelineData[0])
  const [selectedSubtopic, setSelectedSubtopic] = useState<Subtopic | null>(
    timelineData[0]?.subtopics[0] || null
  )
  const [selectedMoments, setSelectedMoments] = useState<Moment[]>(
    timelineData[0]?.subtopics[0]?.moments || []
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const handleSelectTopic = (topic: Topic) => {
    setSelectedTopic(topic)
    setSelectedSubtopic(topic.subtopics[0] || null)
    setSelectedMoments(topic.subtopics[0]?.moments || [])
  }

  const handleSelectSubtopic = (subtopic: Subtopic) => {
    setSelectedSubtopic(subtopic)
    setSelectedMoments(subtopic.moments)
  }

  const handleSelectMoment = (moment: Moment, subtopic: Subtopic) => {
    setSelectedSubtopic(subtopic)
    // Find index of the moment and show it plus surrounding context
    const idx = subtopic.moments.findIndex((m) => m.id === moment.id)
    const start = Math.max(0, idx - 2)
    const end = Math.min(subtopic.moments.length, idx + 5)
    setSelectedMoments(subtopic.moments.slice(start, end))
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Topic Sidebar - like Cursor's file explorer */}
      <div
        className={cn(
          "flex-shrink-0 transition-all duration-200",
          sidebarCollapsed ? "w-0 overflow-hidden" : "w-56"
        )}
      >
        <TopicSidebar
          topics={timelineData}
          selectedTopicId={selectedTopic?.id || null}
          onSelectTopic={handleSelectTopic}
        />
      </div>

      {/* Toggle Button for mobile */}
      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className={cn(
          "absolute top-3 z-10 rounded-md p-1.5 text-muted-foreground transition-all",
          "hover:bg-secondary hover:text-foreground",
          sidebarCollapsed ? "left-3" : "left-[232px]"
        )}
      >
        {sidebarCollapsed ? (
          <PanelLeft className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>

      {/* Outline Pane - like Cursor's outline/symbols view */}
      <div className="w-80 flex-shrink-0 border-r border-border bg-card/30">
        {selectedTopic ? (
          <OutlinePane
            topic={selectedTopic}
            selectedMoments={selectedMoments}
            selectedSubtopicId={selectedSubtopic?.id || null}
            onSelectSubtopic={handleSelectSubtopic}
            onSelectMoment={handleSelectMoment}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a topic
          </div>
        )}
      </div>

      {/* Message Pane - like Cursor's editor */}
      <div className="flex-1 bg-background">
        <MessagePane
          moments={selectedMoments}
          topicTitle={selectedTopic?.title || ""}
          subtopicTitle={selectedSubtopic?.title}
        />
      </div>
    </div>
  )
}
