import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import { DateRange as DayPickerDateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DateRange } from "@/lib/types";

interface DateRangeFilterProps {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
}

function combineDateAndTime(date: Date, time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const combined = new Date(date);
  combined.setHours(hours, minutes, 0, 0);
  return combined.toISOString();
}

export function DateRangeFilter({
  dateRange,
  onDateRangeChange,
}: DateRangeFilterProps) {
  const [open, setOpen] = React.useState(false);
  const [startTime, setStartTime] = React.useState("00:00");
  const [endTime, setEndTime] = React.useState("23:59");

  const [fromDate, setFromDate] = React.useState<Date | undefined>(
    dateRange.start ? new Date(dateRange.start) : undefined,
  );
  const [toDate, setToDate] = React.useState<Date | undefined>(
    dateRange.end ? new Date(dateRange.end) : undefined,
  );

  React.useEffect(() => {
    const newFrom = dateRange.start ? new Date(dateRange.start) : undefined;
    const newTo = dateRange.end ? new Date(dateRange.end) : undefined;
    setFromDate(newFrom);
    setToDate(newTo);

    if (dateRange.start) {
      const d = new Date(dateRange.start);
      setStartTime(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      );
    } else {
      setStartTime("00:00");
    }
    if (dateRange.end) {
      const d = new Date(dateRange.end);
      setEndTime(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      );
    } else {
      setEndTime("23:59");
    }
  }, [dateRange.start, dateRange.end]);

  const selected: DayPickerDateRange | undefined =
    fromDate || toDate ? { from: fromDate, to: toDate } : undefined;

  const emitRange = React.useCallback(
    (
      from: Date | undefined,
      to: Date | undefined,
      sTime: string,
      eTime: string,
    ) => {
      onDateRangeChange({
        start: from ? combineDateAndTime(from, sTime) : undefined,
        end: to ? combineDateAndTime(to, eTime) : undefined,
      });
    },
    [onDateRangeChange],
  );

  const handleCalendarSelect = (range: DayPickerDateRange | undefined) => {
    const from = range?.from;
    const to = range?.to;
    setFromDate(from);
    setToDate(to);
    emitRange(from, to, startTime, endTime);
  };

  const handleStartTimeChange = (value: string) => {
    setStartTime(value);
    emitRange(fromDate, toDate, value, endTime);
  };

  const handleEndTimeChange = (value: string) => {
    setEndTime(value);
    emitRange(fromDate, toDate, startTime, value);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFromDate(undefined);
    setToDate(undefined);
    setStartTime("00:00");
    setEndTime("23:59");
    onDateRangeChange({});
  };

  const hasRange = dateRange.start || dateRange.end;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "justify-start text-left font-normal h-8",
            !hasRange && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {hasRange ? (
            <span className="text-xs">
              {dateRange.start
                ? format(new Date(dateRange.start), "MMM d, yyyy h:mm a")
                : "Start"}
              {" - "}
              {dateRange.end
                ? format(new Date(dateRange.end), "MMM d, yyyy h:mm a")
                : "End"}
            </span>
          ) : (
            <span className="text-xs">Filter by date & time</span>
          )}
          {hasRange && (
            <X
              className="ml-2 h-3 w-3 hover:text-destructive"
              onClick={handleClear}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={selected}
          onSelect={handleCalendarSelect}
          numberOfMonths={2}
          defaultMonth={fromDate}
        />

        <div className="border-t border-border px-4 py-3 space-y-2">
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-14">Start</label>
            <span className="text-xs text-foreground min-w-[90px]">
              {fromDate ? format(fromDate, "MMM d, yyyy") : "---"}
            </span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => handleStartTimeChange(e.target.value)}
              disabled={!fromDate}
              className="h-8 px-2 text-sm border border-input rounded-md bg-background text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground w-14">End</label>
            <span className="text-xs text-foreground min-w-[90px]">
              {toDate ? format(toDate, "MMM d, yyyy") : "---"}
            </span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => handleEndTimeChange(e.target.value)}
              disabled={!toDate}
              className="h-8 px-2 text-sm border border-input rounded-md bg-background text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        {hasRange && (
          <div className="border-t border-border px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground hover:text-destructive"
              onClick={handleClear}
            >
              Reset filter
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
