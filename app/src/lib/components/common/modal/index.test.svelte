<script>
	import { Modal } from '../';
</script>

<div data-testid="open-custom">
	<Modal title="custom title" cancelText="custom cancel text" open={true} />
</div>
<div data-testid="close">
	<Modal open={true} />
</div>
