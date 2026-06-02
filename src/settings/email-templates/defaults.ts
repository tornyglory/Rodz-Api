export const DEFAULT_TEMPLATES = {
  fromAddress: 'bookings@rodz.com.au',
  replyTo: '',
  quoteTemplate: {
    subject: 'Your quote from Rodz Auto — {{quoteNumber}}',
    body:
      'Hi {{customerName}},\n\n' +
      "We've prepared a quote for your {{vehicle}} ({{rego}}).\n\n" +
      'Quote #{{quoteNumber}} — Total: {{total}}\n\n' +
      'View your quote here: {{quoteLink}}\n\n' +
      'If you have any questions, feel free to reply to this email.\n\n' +
      'Rodz Auto {{store}}',
  },
  bookingReceivedTemplate: {
    subject: 'Booking received — {{service}} at Rodz Auto {{store}}',
    body:
      'Hi {{customerName}},\n\n' +
      "Thanks for booking with us! We've received your booking request and will confirm shortly.\n\n" +
      'Vehicle: {{vehicle}} ({{rego}})\n' +
      'Service: {{service}}\n' +
      'Requested date: {{date}}\n' +
      'Time slot: {{slot}}\n\n' +
      'Rodz Auto {{store}}',
  },
  bookingConfirmedTemplate: {
    subject: 'Booking confirmed — {{service}} on {{date}}',
    body:
      'Hi {{customerName}},\n\n' +
      'Great news — your booking is confirmed!\n\n' +
      'Vehicle: {{vehicle}} ({{rego}})\n' +
      'Service: {{service}}\n' +
      'Date: {{date}}\n' +
      'Time slot: {{slot}}\n' +
      'Hoist: {{hoist}}\n\n' +
      'Rodz Auto {{store}}',
  },
  workCommencedTemplate: {
    subject: 'Work has commenced on your {{vehicle}}',
    body:
      'Hi {{customerName}},\n\n' +
      "Just letting you know that work has started on your {{vehicle}} ({{rego}}).\n\n" +
      'Technician: {{tech}}\n' +
      'Service: {{service}}\n' +
      'Store: {{store}}\n\n' +
      "We'll be in touch when your vehicle is ready.\n\n" +
      'Rodz Auto',
  },
  workCompleteTemplate: {
    subject: 'Your {{vehicle}} is ready for pickup',
    body:
      'Hi {{customerName}},\n\n' +
      'Great news — your {{vehicle}} ({{rego}}) is ready for pickup!\n\n' +
      'You can collect your vehicle from:\n{{storeAddress}}\n\n' +
      'Rodz Auto {{store}}',
  },
}
