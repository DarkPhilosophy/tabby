import { Inject, Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { LinkHandler } from './api'

interface XtermLink {
    text: string
    range: { start: { x: number, y: number }, end: { x: number, y: number } }
    activate: (event: MouseEvent, text: string) => void
}

interface XtermLinkProvider {
    provideLinks: (row: number, callback: (links: XtermLink[] | undefined) => void) => void
}

function parseURL (uri: string): URL|null {
    try {
        return new URL(uri)
    } catch {
        return null
    }
}

@Injectable()
export class LinkHighlighterDecorator extends TerminalDecorator {
    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        @Inject(LinkHandler) private handlers: LinkHandler[],
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        if (!(tab.frontend instanceof XTermFrontend)) {
            // not xterm
            return
        }

        tab.frontend.xterm.options.linkHandler = {
            allowNonHttpProtocols: true,
            activate: (event, uri) => {
                if (!this.willHandleEvent(event)) {
                    return
                }
                const url = parseURL(uri)
                if (!url) {
                    return
                }
                // A file: URL with a host is a UNC path - opening it would reach out
                // over SMB to a server the remote side chose. Only allow local files.
                const isLocalFile = url.protocol === 'file:' && !url.host
                if (!['http:', 'https:'].includes(url.protocol) && !isLocalFile) {
                    return
                }
                this.platform.openExternal(url.href)
            },
        }

        const openLink = async uri => {
            for (const handler of this.handlers) {
                if (!handler.fullMatchRegex.test(uri)) {
                    continue
                }
                if (!await handler.verify(await handler.convert(uri, tab), tab)) {
                    continue
                }
                handler.handle(await handler.convert(uri, tab), tab)
                return
            }
        }

        let regex = new RegExp('')
        const regexSource = this.handlers.map(x => `(${x.regex.source})`).join('|')
        try {
            regex = new RegExp(regexSource)
            console.debug('Linkifier regexp', regex)
        } catch (error) {
            console.error('Could not build regex for your link handlers:', error)
            console.error('Regex source was:', regexSource)
            return
        }

        const addon = new WebLinksAddon(
            async (event, uri) => {
                if (!this.willHandleEvent(event)) {
                    return
                }
                openLink(uri)
            },
            {
                urlRegex: regex,
            },
        )

        tab.frontend.xterm.loadAddon(addon)
        this.installSingleClickActivation(tab)
    }

    /**
     * Single-click link activation.
     *
     * xterm only activates a link on mouseup when its Linkifier has already
     * resolved a link for the hovered cell. While an application requests mouse
     * reporting (e.g. tmux mouse mode), the first click is consumed as a mouse
     * report and the activation lands on the second click. Resolve the link
     * directly from the registered link providers at the clicked cell instead,
     * and swallow the button so the pty never sees it — one click, no selection
     * side effects in outer multiplexers.
     */
    private installSingleClickActivation (tab: BaseTerminalTabComponent<any>): void {
        const frontend = tab.frontend as XTermFrontend
        const core = this.xtermCore(frontend)
        const screen: HTMLElement | undefined = core?.screenElement
        if (!screen) {
            return
        }

        let pending: { link: XtermLink, x: number, y: number } | null = null

        // `swallow` pairs a suppressed press with its release: xterm/the pty must
        // never see one half of a click, or the outer multiplexer keeps a stuck
        // button down (and starts selecting).
        let swallow = false

        screen.addEventListener('mousedown', (event: MouseEvent) => {
            pending = null
            swallow = false
            if (event.button !== 0 || !this.willHandleEvent(event)) {
                return
            }
            const hit = this.linkAtEvent(frontend, event)
            if (!hit) {
                return
            }
            // Swallow every left press over a link, including a stray second
            // click of a double: letting it through would reach the outer
            // multiplexer, which selects and overwrites the clipboard.
            swallow = true
            if (event.detail <= 1) {
                pending = hit
            }
            event.preventDefault()
            event.stopImmediatePropagation()
        }, true)

        screen.addEventListener('mouseup', (event: MouseEvent) => {
            const hit = pending
            const suppress = swallow
            pending = null
            swallow = false
            if (event.button !== 0 || !suppress) {
                return
            }
            event.preventDefault()
            event.stopImmediatePropagation()
            if (!hit) {
                return
            }
            const now = this.linkAtEvent(frontend, event)
            if (now && now.link.text === hit.link.text && now.y === hit.y) {
                hit.link.activate(event, hit.link.text)
            }
        }, true)
    }

    private xtermCore (frontend: XTermFrontend): any {
        return (frontend.xterm as any)._core
    }

    /** Resolve a link registered by any provider at the clicked cell, if any. */
    private linkAtEvent (frontend: XTermFrontend, event: MouseEvent): { link: XtermLink, x: number, y: number } | null {
        const core = this.xtermCore(frontend)
        const coords: [number, number] | undefined = core?._mouseService?.getCoords(
            event, core.screenElement, core.cols, core.rows,
        )
        if (!coords) {
            return null
        }
        // Link providers and link ranges are addressed in absolute buffer rows,
        // while getCoords() reports a viewport row.
        const x = coords[0]
        const y = coords[1] + (core._bufferService?.buffer?.ydisp ?? 0)
        const providers: XtermLinkProvider[] = core.linkifier?._linkProviderService?.linkProviders ?? []
        for (const provider of providers) {
            let found: XtermLink | null = null
            // Both bundled providers (OSC 8 and the web-links regex addon) answer
            // synchronously; an async provider simply does not participate here.
            provider.provideLinks(y, links => {
                found = links?.find(link => this.linkCovers(link, x, y)) ?? null
            })
            if (found) {
                return { link: found, x, y }
            }
        }
        return null
    }

    private linkCovers (link: XtermLink, x: number, y: number): boolean {
        const { start, end } = link.range
        if (y < start.y || y > end.y) {
            return false
        }
        if (y === start.y && x < start.x) {
            return false
        }
        if (y === end.y && x > end.x) {
            return false
        }
        return true
    }

    private willHandleEvent (event: MouseEvent) {
        const modifier = this.config.store.clickableLinks.modifier
        return !modifier || event[modifier]
    }
}
