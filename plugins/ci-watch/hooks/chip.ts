import type { ClientSurface } from 'claude-code'

/** What the hooks module hands the chip: its text and color, already measured to the cell. */
export type ChipProps = { text: string; color: string }

/**
 * The CI chip beside the prompt. It also tells the hooks module when the
 * window gains or loses the focus, which no hook can see, so polling can rest
 * while nobody is looking.
 */
export default function Chip(props: ChipProps, surface: ClientSurface<{ isFocused: boolean }>) {
  const { Text } = surface.elements
  if (surface.state?.isFocused !== surface.isWindowFocused) {
    surface.post({ isFocused: surface.isWindowFocused })
    surface.setState({ isFocused: surface.isWindowFocused })
  }
  return Text({ color: props.color, children: props.text })
}
