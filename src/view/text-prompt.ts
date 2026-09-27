import { App, Modal, Setting } from 'obsidian';

export interface TextPromptOptions {
	title: string;
	/** A sentence under the title saying what the text is for. */
	hint?: string;
	placeholder: string;
	value: string;
	/** Called with the trimmed text; an empty string means "clear it". */
	onSubmit: (value: string) => void;
}

/**
 * One line of text: a scene's title, or a cut's label.
 *
 * Enter saves and Escape cancels. Saving an empty line clears the value, so
 * naming and un-naming are the same gesture and neither needs its own button.
 */
export class TextPromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private readonly options: TextPromptOptions,
	) {
		super(app);
		this.value = options.value;
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);
		const { contentEl } = this;
		if (this.options.hint)
			contentEl.createEl('p', {
				cls: 'cine-prompt-hint',
				text: this.options.hint,
			});
		const input = contentEl.createEl('input', {
			cls: 'cine-prompt-input',
			type: 'text',
		});
		input.placeholder = this.options.placeholder;
		input.value = this.value;
		input.addEventListener('input', () => {
			this.value = input.value;
		});
		input.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter' || e.isComposing) return;
			e.preventDefault();
			this.submit();
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Save')
					.setCta()
					.onClick(() => this.submit()),
			);
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		this.options.onSubmit(this.value.trim());
		this.close();
	}
}
