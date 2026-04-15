export async function execute(input, ctx) {
    try {
        const { principal, rate, time, frequency } = input;
        if (principal <= 0 || rate <= 0 || time <= 0 || frequency <= 0) {
            throw new Error('All input values must be greater than zero.');
        }
        const amount = principal * Math.pow((1 + (rate / (frequency * 100))), (frequency * time));
        const interest = amount - principal;
        return { amount, interest };
    } catch (error) {
        return { error: error.message };
    }
}