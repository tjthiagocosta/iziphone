'use client';

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DepartmentAgentResponse } from '@repo/dto';
import { GripVertical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SortableAgentProps {
  agent: DepartmentAgentResponse;
  index: number;
}

function SortableAgent({ agent, index }: SortableAgentProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.userId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 p-3 rounded-md border bg-background"
    >
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium">
        {index + 1}
      </span>
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1">
        <p className="font-medium">{agent.userName || agent.userEmail}</p>
        <p className="text-sm text-muted-foreground">{agent.userEmail}</p>
      </div>
    </div>
  );
}

interface AgentOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: DepartmentAgentResponse[];
  onSave: (data: {
    agentOrder: Array<{ userId: string; order: number }>;
  }) => Promise<void>;
  isLoading?: boolean;
}

export function AgentOrderDialog({
  open,
  onOpenChange,
  agents,
  onSave,
  isLoading = false,
}: AgentOrderDialogProps) {
  const [localAgents, setLocalAgents] = useState<DepartmentAgentResponse[]>([]);

  // Reset local state when dialog opens
  useEffect(() => {
    if (open) {
      // Sort agents by their current order
      const sorted = [...agents].sort((a, b) => a.order - b.order);
      setLocalAgents(sorted);
    }
  }, [open, agents]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setLocalAgents((items) => {
        const oldIndex = items.findIndex((i) => i.userId === active.id);
        const newIndex = items.findIndex((i) => i.userId === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleSave = async () => {
    const agentOrder = localAgents.map((agent, index) => ({
      userId: agent.userId,
      order: index,
    }));
    await onSave({ agentOrder });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Agent Order</DialogTitle>
          <DialogDescription>
            Drag and drop agents to set the order they will be called when using
            fixed order routing.
          </DialogDescription>
        </DialogHeader>

        {localAgents.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No agents assigned to this department. Add agents first before
            setting the call order.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={localAgents.map((a) => a.userId)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2 max-h-[400px] overflow-y-auto py-2">
                {localAgents.map((agent, index) => (
                  <SortableAgent
                    key={agent.userId}
                    agent={agent}
                    index={index}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isLoading || localAgents.length === 0}
          >
            {isLoading ? 'Saving...' : 'Save Order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
