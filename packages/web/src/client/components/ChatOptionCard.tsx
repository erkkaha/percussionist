import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";

export interface OptionDef {
  key: string;
  label: string;
  description?: string;
}

interface ChatOptionCardProps {
  options: OptionDef[];
  onSelect: (key: string) => void;
  disabled?: boolean;
}

/**
 * Renders a card of interactive option buttons for chat messages.
 *
 * Used to display structured [!options] blocks from assistant messages
 * as clickable buttons that submit the selected key via sendText.
 */
export default function ChatOptionCard({
  options,
  onSelect,
  disabled = false,
}: ChatOptionCardProps) {
  return (
    <Card className="mt-3 w-full">
      <CardContent className="space-y-2 p-3">
        {options.map((option, idx) => (
          <div key={idx} className="flex flex-col gap-0.5">
            <Button
              type="button"
              variant="secondary"
              className="w-full justify-start text-sm whitespace-normal text-left h-auto min-h-9 py-2"
              disabled={disabled}
              onClick={() => onSelect(option.key)}
            >
              <span className="font-medium">{option.label}</span>
            </Button>
            {option.description && (
              <p className="text-xs text-text-dim px-1 leading-relaxed">
                {option.description}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
