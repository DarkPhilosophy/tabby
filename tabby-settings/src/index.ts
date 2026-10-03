import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { InfiniteScrollModule } from 'ngx-infinite-scroll'

import TabbyCorePlugin, { ToolbarButtonProvider, HotkeyProvider, ConfigProvider, HotkeysService, AppService } from 'tabby-core'

import { EditProfileModalComponent } from './components/editProfileModal.component'
import { EditProfileGroupModalComponent } from './components/editProfileGroupModal.component'
import { HotkeyInputModalComponent } from './components/hotkeyInputModal.component'
import { HotkeySettingsTabComponent } from './components/hotkeySettingsTab.component'
import { MultiHotkeyInputComponent } from './components/multiHotkeyInput.component'
import { SettingsTabComponent } from './components/settingsTab.component'
import { SettingsTabBodyComponent } from './components/settingsTabBody.component'
import { WindowSettingsTabComponent } from './components/windowSettingsTab.component'
import { VaultSettingsTabComponent }  from './components/vaultSettingsTab.component'
import { SetVaultPassphraseModalComponent } from './components/setVaultPassphraseModal.component'
import { ProfilesSettingsTabComponent } from './components/profilesSettingsTab.component'
import { ReleaseNotesComponent } from './components/releaseNotesTab.component'
import { SyncSettingsTabComponent } from './components/syncSettingsTab.component'
import { ShowSecretModalComponent } from './components/showSecretModal.component'

import { SYNC_TRANSPORT_PROVIDERS } from './sync/transports'
import { SyncService } from './sync/sync.service'

import { SettingsTabProvider } from './api'
import { ButtonProvider } from './buttonProvider'
import { SettingsHotkeyProvider } from './hotkeys'
import { SettingsConfigProvider } from './config'
import { HotkeySettingsTabProvider, WindowSettingsTabProvider, VaultSettingsTabProvider, ProfilesSettingsTabProvider, SyncSettingsTabProvider } from './settings'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCorePlugin,
        InfiniteScrollModule,
    ],
    providers: [
        { provide: ToolbarButtonProvider, useClass: ButtonProvider, multi: true },
        { provide: ConfigProvider, useClass: SettingsConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: SettingsHotkeyProvider, multi: true },
        { provide: SettingsTabProvider, useClass: HotkeySettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: WindowSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: VaultSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: ProfilesSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: SyncSettingsTabProvider, multi: true },
        ...SYNC_TRANSPORT_PROVIDERS,
    ],
    declarations: [
        EditProfileModalComponent,
        EditProfileGroupModalComponent,
        HotkeyInputModalComponent,
        HotkeySettingsTabComponent,
        MultiHotkeyInputComponent,
        ProfilesSettingsTabComponent,
        SettingsTabComponent,
        SettingsTabBodyComponent,
        SetVaultPassphraseModalComponent,
        VaultSettingsTabComponent,
        WindowSettingsTabComponent,
        SyncSettingsTabComponent,
        ReleaseNotesComponent,
        ShowSecretModalComponent,
    ],
})
export default class SettingsModule {
    constructor (
        public sync: SyncService,
        app: AppService,
        hotkeys: HotkeysService,
    ) {
        hotkeys.hotkey$.subscribe(async hotkey => {
            if (hotkey.startsWith('settings-tab.')) {
                const id = hotkey.substring(hotkey.indexOf('.') + 1)
                app.openNewTabRaw({
                    type: SettingsTabComponent,
                    inputs: { activeTab: id },
                })
            }
        })
    }
}

export * from './api'
export {
    SettingsTabComponent,
    EditProfileModalComponent,
    EditProfileGroupModalComponent,
}
