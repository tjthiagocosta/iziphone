'use client';

import { FileText, Paperclip, Send, Smile } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface MessageInputProps {
  onSend?: (message: string) => void;
  placeholder?: string;
}

export function MessageInput({
  onSend,
  placeholder = 'New message',
}: MessageInputProps) {
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (message.trim() && onSend) {
      onSend(message);
      setMessage('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border bg-background p-4">
      <div className="flex items-end gap-2">
        <div className="flex-1 bg-card rounded-lg border border-border">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="w-full bg-transparent px-4 py-3 text-sm resize-none focus:outline-hidden placeholder:text-muted-foreground"
            style={{ minHeight: '44px', maxHeight: '120px' }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center gap-1 px-2 pb-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach file</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  <Smile className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add emoji</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                >
                  <FileText className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Use template</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Button
          onClick={handleSend}
          disabled={!message.trim()}
          size="icon"
          className="h-11 w-11 rounded-full bg-info hover:bg-info/90 disabled:bg-muted disabled:text-muted-foreground"
        >
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
