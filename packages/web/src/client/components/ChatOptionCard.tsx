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
    <Card className="mt-3 max-w-[80%]">
      <CardContent className="space-y-2 p-3">
        {options.map((option, idx) => (
          <Button
            key={idx}
            type="button"
            variant="secondary"
            className="w-full justify-start text-sm"
            disabled={disabled}
            onClick={() => onSelect(option.key)}
          >
            <div className="flex flex-col items-start">
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <span className="text-xs text-text-dim mt-0.5">
                  {option.description}
                </span>
              )}
            </div>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
